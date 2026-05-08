import type {
  CompositionPlan,
  CompositionStep,
  CompositionTrigger,
} from "./composition-planner.js";

export interface CompositionExecutor {
  readonly execute: (
    trigger: CompositionTrigger,
    plan: CompositionPlan,
  ) => Promise<CompositionExecutionResult>;
}

export interface CompositionExecutionError {
  readonly code: "APPROVAL_REQUIRED" | "STEP_UNSUPPORTED" | "STEP_FAILED" | "INVALID_PLAN";
  readonly message: string;
  readonly stepKind?: CompositionStep["kind"] | undefined;
}

type CompositionApprovalRequiredError = CompositionExecutionError & {
  readonly code: "APPROVAL_REQUIRED";
};

type CompositionUnsupportedError = CompositionExecutionError & {
  readonly code: "STEP_UNSUPPORTED" | "INVALID_PLAN";
};

type CompositionFailureError = CompositionExecutionError & {
  readonly code: "STEP_FAILED" | "INVALID_PLAN";
};

interface CompositionStepResultBase {
  readonly step: CompositionStep;
}

type ExecutedCompositionStepResult = CompositionStepResultBase & {
  readonly status: "executed";
  readonly output?: unknown;
  readonly error?: undefined;
};

type SkippedCompositionStepResult = CompositionStepResultBase & {
  readonly status: "skipped";
  readonly output?: undefined;
  readonly error?: undefined;
};

type UnsupportedCompositionStepResult = CompositionStepResultBase & {
  readonly status: "unsupported";
  readonly output?: undefined;
  readonly error: CompositionUnsupportedError;
};

type FailedCompositionStepResult = CompositionStepResultBase & {
  readonly status: "failed";
  readonly output?: undefined;
  readonly error: CompositionFailureError;
};

export type CompositionStepResult =
  | ExecutedCompositionStepResult
  | SkippedCompositionStepResult
  | UnsupportedCompositionStepResult
  | FailedCompositionStepResult;

export type SuccessfulCompositionStepResult =
  | ExecutedCompositionStepResult
  | SkippedCompositionStepResult;

interface CompositionExecutionResultBase<
  TStepResult extends CompositionStepResult = CompositionStepResult,
> {
  readonly triggerId: string;
  readonly stepResults: readonly TStepResult[];
  readonly executedCount: number;
}

export type CompositionExecutionResult =
  | (CompositionExecutionResultBase<SuccessfulCompositionStepResult> & {
      readonly status: "executed";
      readonly error?: undefined;
    })
  | {
      readonly triggerId: string;
      readonly status: "requires_approval";
      readonly stepResults: readonly [];
      readonly executedCount: 0;
      readonly error: CompositionApprovalRequiredError;
    }
  | (CompositionExecutionResultBase & {
      readonly status: "unsupported";
      readonly error: CompositionUnsupportedError;
    })
  | (CompositionExecutionResultBase & {
      readonly status: "failed";
      readonly error: CompositionFailureError;
    });
