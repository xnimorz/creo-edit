import { afterEach, describe, expect, it } from "bun:test";
import "../../__tests__/setup";
import { __resetCoarsePointerCache, isCoarsePointer } from "../mobile";

afterEach(() => {
  __resetCoarsePointerCache();
});

describe("mobile — isCoarsePointer", () => {
  it("returns false when matchMedia(coarse) does not match", () => {
    (window as unknown as { matchMedia: (q: string) => MediaQueryList })
      .matchMedia = (q: string) =>
      ({ matches: false, media: q } as MediaQueryList);
    expect(isCoarsePointer()).toBe(false);
  });

  it("returns true when matchMedia(coarse) matches (cached)", () => {
    (window as unknown as { matchMedia: (q: string) => MediaQueryList })
      .matchMedia = (q: string) =>
      ({ matches: true, media: q } as MediaQueryList);
    expect(isCoarsePointer()).toBe(true);
    // Cache: a second call doesn't re-query.
    (window as unknown as { matchMedia: (q: string) => MediaQueryList })
      .matchMedia = (() => {
        throw new Error("matchMedia must not be re-queried");
      }) as never;
    expect(isCoarsePointer()).toBe(true);
  });
});
