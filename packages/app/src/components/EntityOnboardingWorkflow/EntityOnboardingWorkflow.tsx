import React from 'react';
import {
  ANNOTATION_ORIGIN_LOCATION,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import { useEntity } from '@backstage/plugin-catalog-react';
import {
  EmbeddedScaffolderWorkflowProps,
  Stepper,
  useRunWorkflow,
  useWorkflowManifest,
  type RunWorkflow,
  TaskProgress,
  Workflow,
} from '@frontside/backstage-plugin-scaffolder-workflow';
import { assert } from 'assert-ts';

import { ScaffolderFieldExtensions } from '@backstage/plugin-scaffolder-react';
import { characterTextField } from './FieldExtension';
import { scaffolderPlugin } from '@backstage/plugin-scaffolder';
import {
  createNextScaffolderFieldExtension,
  ParsedTemplateSchema,
} from '@backstage/plugin-scaffolder-react/alpha';

import {
  Stepper as MuiStepper,
  Step as MuiStep,
  StepLabel as MuiStepLabel,
  Button,
} from '@material-ui/core';

export const configuredFieldExtensions = [characterTextField].map(extension =>
  scaffolderPlugin.provide(createNextScaffolderFieldExtension(extension)),
);

type EntityOnboardingWorkflowProps = EmbeddedScaffolderWorkflowProps;

function OnboardingActions({
  stepper,
}: {
  stepper?: Stepper;
  workflow: RunWorkflow;
}) {
  if (stepper)
    return (
      <>
        <Button
          onClick={stepper.handleBack}
          disabled={stepper.activeStep < 1 || stepper.isValidating}
        >
          Back
        </Button>
        <Button
          variant="contained"
          color="primary"
          type="submit"
          disabled={stepper.isValidating}
        >
          {stepper.activeStep === stepper.steps.length - 1 ? 'Review' : 'Next'}
        </Button>
      </>
    );
  return null;
}

export function EntityOnboardingWorkflow(
  props: EntityOnboardingWorkflowProps,
): JSX.Element | null {
  const { entity } = useEntity();

  const entityRef = stringifyEntityRef(entity);

  const catalogInfoUrl = entity.metadata?.annotations?.[
    ANNOTATION_ORIGIN_LOCATION
  ].replace(/^url:/, '');

  assert(
    !!catalogInfoUrl,
    `no catalog-info.yaml url in ${ANNOTATION_ORIGIN_LOCATION} annotation`,
  );

  const { loading, manifest } = useWorkflowManifest({
    name: props.templateName,
    namespace: props.namespace,
  });

  const templateRef = stringifyEntityRef({
    kind: 'Template',
    namespace: props.namespace,
    name: props.templateName,
  });

  const workflowErrorHandler = () => {
    // when ...args: any[]
    // console.log('workflow error', args);
  };

  const workflowCompleteHandler = () => {
    // when ...args: any[]
    // console.log('workflow complete', args);
  };

  const workflow = useRunWorkflow({
    templateRef,
    onError: workflowErrorHandler,
    onComplete: workflowCompleteHandler,
  });

  if (loading) {
    return <>Loading template...</>;
  }

  return manifest ? (
    <>
      <Workflow
        manifest={manifest}
        workflow={workflow}
        initialState={{ entityRef, catalogInfoUrl }}
        formFooter={<OnboardingActions workflow={workflow} />}
        stepperProgress={<StepperProgress />}
        reviewComponent={<EntityOnboardingReview workflow={workflow} />}
      >
        <ScaffolderFieldExtensions>
          {configuredFieldExtensions.map((FieldExtension, index) => (
            <FieldExtension key={`fieldExtension${index}`} />
          ))}
        </ScaffolderFieldExtensions>
      </Workflow>
      {workflow.taskStream.loading === false && (
        <TaskProgress taskStream={workflow.taskStream} />
      )}
    </>
  ) : null;
}

function EntityOnboardingReview({
  stepper,
  workflow,
}: {
  stepper?: Stepper;
  workflow: RunWorkflow;
}) {
  if (stepper) {
    return (
      <>
        <ul>
          {Object.entries(stepper.formState).map(([key, value]) => (
            <li key={key}>
              <strong>{key}</strong>: {value}
            </li>
          ))}
        </ul>
        <button onClick={() => stepper.handleBack()}>Back</button>
        <button onClick={() => workflow.execute(stepper.formState)}>Run</button>
      </>
    );
  }

  return null;
}

function StepperProgress({
  activeStep,
  steps = [],
}: {
  activeStep?: number;
  steps?: ParsedTemplateSchema[];
}) {
  return (
    <MuiStepper activeStep={activeStep} alternativeLabel variant="elevation">
      {steps.map((step, index) => (
        <MuiStep key={index}>
          <MuiStepLabel>{step.title}</MuiStepLabel>
        </MuiStep>
      ))}
      <MuiStep>
        <MuiStepLabel>Review</MuiStepLabel>
      </MuiStep>
    </MuiStepper>
  );
}
