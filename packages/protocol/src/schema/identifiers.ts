import * as S from "effect/Schema";

export const RequestId = S.NonEmptyString.pipe(S.brand("RequestId"));
export type RequestId = typeof RequestId.Type;

export const WorkerId = S.NonEmptyString.pipe(S.brand("WorkerId"));
export type WorkerId = typeof WorkerId.Type;

export const DeploymentId = S.NonEmptyString.pipe(S.brand("DeploymentId"));
export type DeploymentId = typeof DeploymentId.Type;

export const HttpStatusCode = S.Int.pipe(
  S.check(S.isGreaterThanOrEqualTo(100), S.isLessThanOrEqualTo(599)),
  S.brand("HttpStatusCode")
);
export type HttpStatusCode = typeof HttpStatusCode.Type;
