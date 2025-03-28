import * as cfn_diff from '@aws-cdk/cloudformation-diff';
import * as cxapi from '@aws-cdk/cx-api';
import { WaiterResult } from '@smithy/util-waiter';
import * as chalk from 'chalk';
import type { SDK, SdkProvider } from './aws-auth';
import type { SuccessfulDeployStackResult } from './deploy-stack';
import { EvaluateCloudFormationTemplate } from './evaluate-cloudformation-template';
import { info } from '../logging';
import { isHotswappableAppSyncChange } from './hotswap/appsync-mapping-templates';
import { isHotswappableCodeBuildProjectChange } from './hotswap/code-build-projects';
import {
  ICON,
  ChangeHotswapResult,
  HotswapMode,
  HotswappableChange,
  NonHotswappableChange,
  HotswappableChangeCandidate,
  HotswapPropertyOverrides, ClassifiedResourceChanges,
  reportNonHotswappableChange,
  reportNonHotswappableResource,
} from './hotswap/common';
import { isHotswappableEcsServiceChange } from './hotswap/ecs-services';
import { isHotswappableLambdaFunctionChange } from './hotswap/lambda-functions';
import {
  skipChangeForS3DeployCustomResourcePolicy,
  isHotswappableS3BucketDeploymentChange,
} from './hotswap/s3-bucket-deployments';
import { isHotswappableStateMachineChange } from './hotswap/stepfunctions-state-machines';
import { NestedStackTemplates, loadCurrentTemplateWithNestedStacks } from './nested-stack-helpers';
import { Mode } from './plugin/mode';
import { CloudFormationStack } from './util/cloudformation';
import { ToolkitError } from '../toolkit/error';
import { formatErrorMessage } from '../util/error';

// Must use a require() otherwise esbuild complains about calling a namespace
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pLimit: typeof import('p-limit') = require('p-limit');

type HotswapDetector = (
  logicalId: string,
  change: HotswappableChangeCandidate,
  evaluateCfnTemplate: EvaluateCloudFormationTemplate,
  hotswapPropertyOverrides: HotswapPropertyOverrides,
) => Promise<ChangeHotswapResult>;

const RESOURCE_DETECTORS: { [key: string]: HotswapDetector } = {
  // Lambda
  'AWS::Lambda::Function': isHotswappableLambdaFunctionChange,
  'AWS::Lambda::Version': isHotswappableLambdaFunctionChange,
  'AWS::Lambda::Alias': isHotswappableLambdaFunctionChange,

  // AppSync
  'AWS::AppSync::Resolver': isHotswappableAppSyncChange,
  'AWS::AppSync::FunctionConfiguration': isHotswappableAppSyncChange,
  'AWS::AppSync::GraphQLSchema': isHotswappableAppSyncChange,
  'AWS::AppSync::ApiKey': isHotswappableAppSyncChange,

  'AWS::ECS::TaskDefinition': isHotswappableEcsServiceChange,
  'AWS::CodeBuild::Project': isHotswappableCodeBuildProjectChange,
  'AWS::StepFunctions::StateMachine': isHotswappableStateMachineChange,
  'Custom::CDKBucketDeployment': isHotswappableS3BucketDeploymentChange,
  'AWS::IAM::Policy': async (
    logicalId: string,
    change: HotswappableChangeCandidate,
    evaluateCfnTemplate: EvaluateCloudFormationTemplate,
  ): Promise<ChangeHotswapResult> => {
    // If the policy is for a S3BucketDeploymentChange, we can ignore the change
    if (await skipChangeForS3DeployCustomResourcePolicy(logicalId, change, evaluateCfnTemplate)) {
      return [];
    }

    return reportNonHotswappableResource(change, 'This resource type is not supported for hotswap deployments');
  },

  'AWS::CDK::Metadata': async () => [],
};

/**
 * Perform a hotswap deployment, short-circuiting CloudFormation if possible.
 * If it's not possible to short-circuit the deployment
 * (because the CDK Stack contains changes that cannot be deployed without CloudFormation),
 * returns `undefined`.
 */
export async function tryHotswapDeployment(
  sdkProvider: SdkProvider,
  assetParams: { [key: string]: string },
  cloudFormationStack: CloudFormationStack,
  stackArtifact: cxapi.CloudFormationStackArtifact,
  hotswapMode: HotswapMode, hotswapPropertyOverrides: HotswapPropertyOverrides,
): Promise<SuccessfulDeployStackResult | undefined> {
  // resolve the environment, so we can substitute things like AWS::Region in CFN expressions
  const resolvedEnv = await sdkProvider.resolveEnvironment(stackArtifact.environment);
  // create a new SDK using the CLI credentials, because the default one will not work for new-style synthesis -
  // it assumes the bootstrap deploy Role, which doesn't have permissions to update Lambda functions
  const sdk = (await sdkProvider.forEnvironment(resolvedEnv, Mode.ForWriting)).sdk;

  const currentTemplate = await loadCurrentTemplateWithNestedStacks(stackArtifact, sdk);

  const evaluateCfnTemplate = new EvaluateCloudFormationTemplate({
    stackName: stackArtifact.stackName,
    template: stackArtifact.template,
    parameters: assetParams,
    account: resolvedEnv.account,
    region: resolvedEnv.region,
    partition: (await sdk.currentAccount()).partition,
    sdk,
    nestedStacks: currentTemplate.nestedStacks,
  });

  const stackChanges = cfn_diff.fullDiff(currentTemplate.deployedRootTemplate, stackArtifact.template);
  const { hotswappableChanges, nonHotswappableChanges } = await classifyResourceChanges(
    stackChanges,
    evaluateCfnTemplate,
    sdk,
    currentTemplate.nestedStacks, hotswapPropertyOverrides,
  );

  logNonHotswappableChanges(nonHotswappableChanges, hotswapMode);

  // preserve classic hotswap behavior
  if (hotswapMode === HotswapMode.FALL_BACK) {
    if (nonHotswappableChanges.length > 0) {
      return undefined;
    }
  }

  // apply the short-circuitable changes
  await applyAllHotswappableChanges(sdk, hotswappableChanges);

  return {
    type: 'did-deploy-stack',
    noOp: hotswappableChanges.length === 0,
    stackArn: cloudFormationStack.stackId,
    outputs: cloudFormationStack.outputs,
  };
}

/**
 * Classifies all changes to all resources as either hotswappable or not.
 * Metadata changes are excluded from the list of (non)hotswappable resources.
 */
async function classifyResourceChanges(
  stackChanges: cfn_diff.TemplateDiff,
  evaluateCfnTemplate: EvaluateCloudFormationTemplate,
  sdk: SDK,
  nestedStackNames: { [nestedStackName: string]: NestedStackTemplates },
  hotswapPropertyOverrides: HotswapPropertyOverrides,
): Promise<ClassifiedResourceChanges> {
  const resourceDifferences = getStackResourceDifferences(stackChanges);

  const promises: Array<() => Promise<ChangeHotswapResult>> = [];
  const hotswappableResources = new Array<HotswappableChange>();
  const nonHotswappableResources = new Array<NonHotswappableChange>();
  for (const logicalId of Object.keys(stackChanges.outputs.changes)) {
    nonHotswappableResources.push({
      hotswappable: false,
      reason: 'output was changed',
      logicalId,
      rejectedChanges: [],
      resourceType: 'Stack Output',
    });
  }
  // gather the results of the detector functions
  for (const [logicalId, change] of Object.entries(resourceDifferences)) {
    if (change.newValue?.Type === 'AWS::CloudFormation::Stack' && change.oldValue?.Type === 'AWS::CloudFormation::Stack') {
      const nestedHotswappableResources = await findNestedHotswappableChanges(
        logicalId,
        change,
        nestedStackNames,
        evaluateCfnTemplate,
        sdk,
        hotswapPropertyOverrides,
      );
      hotswappableResources.push(...nestedHotswappableResources.hotswappableChanges);
      nonHotswappableResources.push(...nestedHotswappableResources.nonHotswappableChanges);

      continue;
    }

    const hotswappableChangeCandidate = isCandidateForHotswapping(change, logicalId);
    // we don't need to run this through the detector functions, we can already judge this
    if ('hotswappable' in hotswappableChangeCandidate) {
      if (!hotswappableChangeCandidate.hotswappable) {
        nonHotswappableResources.push(hotswappableChangeCandidate);
      }

      continue;
    }

    const resourceType: string = hotswappableChangeCandidate.newValue.Type;
    if (resourceType in RESOURCE_DETECTORS) {
      // run detector functions lazily to prevent unhandled promise rejections
      promises.push(() =>
        RESOURCE_DETECTORS[resourceType](logicalId, hotswappableChangeCandidate, evaluateCfnTemplate, hotswapPropertyOverrides),
      );
    } else {
      reportNonHotswappableChange(
        nonHotswappableResources,
        hotswappableChangeCandidate,
        undefined,
        'This resource type is not supported for hotswap deployments',
      );
    }
  }

  // resolve all detector results
  const changesDetectionResults: Array<ChangeHotswapResult> = [];
  for (const detectorResultPromises of promises) {
    // Constant set of promises per resource
    // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
    const hotswapDetectionResults = await Promise.all(await detectorResultPromises());
    changesDetectionResults.push(hotswapDetectionResults);
  }

  for (const resourceDetectionResults of changesDetectionResults) {
    for (const propertyResult of resourceDetectionResults) {
      propertyResult.hotswappable
        ? hotswappableResources.push(propertyResult)
        : nonHotswappableResources.push(propertyResult);
    }
  }

  return {
    hotswappableChanges: hotswappableResources,
    nonHotswappableChanges: nonHotswappableResources,
  };
}

/**
 * Returns all changes to resources in the given Stack.
 *
 * @param stackChanges the collection of all changes to a given Stack
 */
function getStackResourceDifferences(stackChanges: cfn_diff.TemplateDiff): {
  [logicalId: string]: cfn_diff.ResourceDifference;
} {
  // we need to collapse logical ID rename changes into one change,
  // as they are represented in stackChanges as a pair of two changes: one addition and one removal
  const allResourceChanges: { [logId: string]: cfn_diff.ResourceDifference } = stackChanges.resources.changes;
  const allRemovalChanges = filterDict(allResourceChanges, (resChange) => resChange.isRemoval);
  const allNonRemovalChanges = filterDict(allResourceChanges, (resChange) => !resChange.isRemoval);
  for (const [logId, nonRemovalChange] of Object.entries(allNonRemovalChanges)) {
    if (nonRemovalChange.isAddition) {
      const addChange = nonRemovalChange;
      // search for an identical removal change
      const identicalRemovalChange = Object.entries(allRemovalChanges).find(([_, remChange]) => {
        return changesAreForSameResource(remChange, addChange);
      });
      // if we found one, then this means this is a rename change
      if (identicalRemovalChange) {
        const [removedLogId, removedResourceChange] = identicalRemovalChange;
        allNonRemovalChanges[logId] = makeRenameDifference(removedResourceChange, addChange);
        // delete the removal change that forms the rename pair
        delete allRemovalChanges[removedLogId];
      }
    }
  }
  // the final result are all of the remaining removal changes,
  // plus all of the non-removal changes
  // (we saved the rename changes in that object already)
  return {
    ...allRemovalChanges,
    ...allNonRemovalChanges,
  };
}

/** Filters an object with string keys based on whether the callback returns 'true' for the given value in the object. */
function filterDict<T>(dict: { [key: string]: T }, func: (t: T) => boolean): { [key: string]: T } {
  return Object.entries(dict).reduce(
    (acc, [key, t]) => {
      if (func(t)) {
        acc[key] = t;
      }
      return acc;
    },
    {} as { [key: string]: T },
  );
}

/** Finds any hotswappable changes in all nested stacks. */
async function findNestedHotswappableChanges(
  logicalId: string,
  change: cfn_diff.ResourceDifference,
  nestedStackTemplates: { [nestedStackName: string]: NestedStackTemplates },
  evaluateCfnTemplate: EvaluateCloudFormationTemplate,
  sdk: SDK,
  hotswapPropertyOverrides: HotswapPropertyOverrides,
): Promise<ClassifiedResourceChanges> {
  const nestedStack = nestedStackTemplates[logicalId];
  if (!nestedStack.physicalName) {
    return {
      hotswappableChanges: [],
      nonHotswappableChanges: [
        {
          hotswappable: false,
          logicalId,
          reason: `physical name for AWS::CloudFormation::Stack '${logicalId}' could not be found in CloudFormation, so this is a newly created nested stack and cannot be hotswapped`,
          rejectedChanges: [],
          resourceType: 'AWS::CloudFormation::Stack',
        },
      ],
    };
  }

  const evaluateNestedCfnTemplate = await evaluateCfnTemplate.createNestedEvaluateCloudFormationTemplate(
    nestedStack.physicalName,
    nestedStack.generatedTemplate,
    change.newValue?.Properties?.Parameters,
  );

  const nestedDiff = cfn_diff.fullDiff(
    nestedStackTemplates[logicalId].deployedTemplate,
    nestedStackTemplates[logicalId].generatedTemplate,
  );

  return classifyResourceChanges(
    nestedDiff,
    evaluateNestedCfnTemplate,
    sdk,
    nestedStackTemplates[logicalId].nestedStackTemplates,
    hotswapPropertyOverrides);
}

/** Returns 'true' if a pair of changes is for the same resource. */
function changesAreForSameResource(
  oldChange: cfn_diff.ResourceDifference,
  newChange: cfn_diff.ResourceDifference,
): boolean {
  return (
    oldChange.oldResourceType === newChange.newResourceType &&
    // this isn't great, but I don't want to bring in something like underscore just for this comparison
    JSON.stringify(oldChange.oldProperties) === JSON.stringify(newChange.newProperties)
  );
}

function makeRenameDifference(
  remChange: cfn_diff.ResourceDifference,
  addChange: cfn_diff.ResourceDifference,
): cfn_diff.ResourceDifference {
  return new cfn_diff.ResourceDifference(
    // we have to fill in the old value, because otherwise this will be classified as a non-hotswappable change
    remChange.oldValue,
    addChange.newValue,
    {
      resourceType: {
        oldType: remChange.oldResourceType,
        newType: addChange.newResourceType,
      },
      propertyDiffs: (addChange as any).propertyDiffs,
      otherDiffs: (addChange as any).otherDiffs,
    },
  );
}

/**
 * Returns a `HotswappableChangeCandidate` if the change is hotswappable
 * Returns an empty `HotswappableChange` if the change is to CDK::Metadata
 * Returns a `NonHotswappableChange` if the change is not hotswappable
 */
function isCandidateForHotswapping(
  change: cfn_diff.ResourceDifference,
  logicalId: string,
): HotswappableChange | NonHotswappableChange | HotswappableChangeCandidate {
  // a resource has been removed OR a resource has been added; we can't short-circuit that change
  if (!change.oldValue) {
    return {
      hotswappable: false,
      resourceType: change.newValue!.Type,
      logicalId,
      rejectedChanges: [],
      reason: `resource '${logicalId}' was created by this deployment`,
    };
  } else if (!change.newValue) {
    return {
      hotswappable: false,
      resourceType: change.oldValue!.Type,
      logicalId,
      rejectedChanges: [],
      reason: `resource '${logicalId}' was destroyed by this deployment`,
    };
  }

  // a resource has had its type changed
  if (change.newValue?.Type !== change.oldValue?.Type) {
    return {
      hotswappable: false,
      resourceType: change.newValue?.Type,
      logicalId,
      rejectedChanges: [],
      reason: `resource '${logicalId}' had its type changed from '${change.oldValue?.Type}' to '${change.newValue?.Type}'`,
    };
  }

  return {
    logicalId,
    oldValue: change.oldValue,
    newValue: change.newValue,
    propertyUpdates: change.propertyUpdates,
  };
}

async function applyAllHotswappableChanges(sdk: SDK, hotswappableChanges: HotswappableChange[]): Promise<void[]> {
  if (hotswappableChanges.length > 0) {
    info(`\n${ICON} hotswapping resources:`);
  }
  const limit = pLimit(10);
  // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
  return Promise.all(hotswappableChanges.map(hotswapOperation => limit(() => {
    return applyHotswappableChange(sdk, hotswapOperation);
  })));
}

async function applyHotswappableChange(sdk: SDK, hotswapOperation: HotswappableChange): Promise<void> {
  // note the type of service that was successfully hotswapped in the User-Agent
  const customUserAgent = `cdk-hotswap/success-${hotswapOperation.service}`;
  sdk.appendCustomUserAgent(customUserAgent);

  for (const name of hotswapOperation.resourceNames) {
    info(`   ${ICON} %s`, chalk.bold(name));
  }

  // if the SDK call fails, an error will be thrown by the SDK
  // and will prevent the green 'hotswapped!' text from being displayed
  try {
    await hotswapOperation.apply(sdk);
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      const result: WaiterResult = JSON.parse(formatErrorMessage(e));
      const error = new ToolkitError(formatWaiterErrorResult(result));
      error.name = e.name;
      throw error;
    }
    throw e;
  }

  for (const name of hotswapOperation.resourceNames) {
    info(`${ICON} %s %s`, chalk.bold(name), chalk.green('hotswapped!'));
  }

  sdk.removeCustomUserAgent(customUserAgent);
}

function formatWaiterErrorResult(result: WaiterResult) {
  const main = [
    `Resource is not in the expected state due to waiter status: ${result.state}`,
    result.reason ? `${result.reason}.` : '',
  ].join('. ');

  if (result.observedResponses != null) {
    const observedResponses = Object
      .entries(result.observedResponses)
      .map(([msg, count]) => `  - ${msg} (${count})`)
      .join('\n');

    return `${main} Observed responses:\n${observedResponses}`;
  }

  return main;
}

function logNonHotswappableChanges(nonHotswappableChanges: NonHotswappableChange[], hotswapMode: HotswapMode): void {
  if (nonHotswappableChanges.length === 0) {
    return;
  }
  /**
   * EKS Services can have a task definition that doesn't refer to the task definition being updated.
   * We have to log this as a non-hotswappable change to the task definition, but when we do,
   * we wind up hotswapping the task definition and logging it as a non-hotswappable change.
   *
   * This logic prevents us from logging that change as non-hotswappable when we hotswap it.
   */
  if (hotswapMode === HotswapMode.HOTSWAP_ONLY) {
    nonHotswappableChanges = nonHotswappableChanges.filter((change) => change.hotswapOnlyVisible === true);

    if (nonHotswappableChanges.length === 0) {
      return;
    }
  }
  if (hotswapMode === HotswapMode.HOTSWAP_ONLY) {
    info(
      '\n%s %s',
      chalk.red('⚠️'),
      chalk.red(
        'The following non-hotswappable changes were found. To reconcile these using CloudFormation, specify --hotswap-fallback',
      ),
    );
  } else {
    info('\n%s %s', chalk.red('⚠️'), chalk.red('The following non-hotswappable changes were found:'));
  }

  for (const change of nonHotswappableChanges) {
    change.rejectedChanges.length > 0
      ? info(
        '    logicalID: %s, type: %s, rejected changes: %s, reason: %s',
        chalk.bold(change.logicalId),
        chalk.bold(change.resourceType),
        chalk.bold(change.rejectedChanges),
        chalk.red(change.reason),
      )
      : info(
        '    logicalID: %s, type: %s, reason: %s',
        chalk.bold(change.logicalId),
        chalk.bold(change.resourceType),
        chalk.red(change.reason),
      );
  }

  info(''); // newline
}
