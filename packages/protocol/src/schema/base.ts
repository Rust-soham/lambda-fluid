import * as S from "effect/Schema";

export const NonNegativeInt = S.Int.check(S.isGreaterThanOrEqualTo(0));

export const PositiveInt = S.Int.check(S.isGreaterThan(0));

export const ProtocolVersion = S.Literal(1);
