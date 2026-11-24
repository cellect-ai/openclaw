export class ReplyRunAlreadyActiveError extends Error {
  constructor(sessionKey: string) {
    super(`Reply run already active for ${sessionKey}`);
    this.name = "ReplyRunAlreadyActiveError";
  }
}

/** A mutation or finishing owner fences admission without owning an active run. */
export class ReplyRunLifecycleAdmissionBlockedError extends Error {
  constructor(
    sessionKey: string,
    readonly databaseIncarnation?: string,
  ) {
    super(`Session "${sessionKey}" changed during turn admission. Retry.`);
    this.name = "ReplyRunLifecycleAdmissionBlockedError";
  }
}

export class ReplyRunFollowupAdmissionBlockedError extends Error {
  constructor(sessionKey: string) {
    super(`Reply follow-up admission is blocked for ${sessionKey}`);
    this.name = "ReplyRunFollowupAdmissionBlockedError";
  }
}

export class ReplyRunSuccessorAdmissionBlockedError extends Error {
  constructor(sessionKey: string) {
    super(`Reply successor admission is blocked for ${sessionKey}`);
    this.name = "ReplyRunSuccessorAdmissionBlockedError";
  }
}
