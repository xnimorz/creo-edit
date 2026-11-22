import { h1, h2, h3, h4, h5, h6, view } from "creo";
import type { HeadingBlock } from "../../model/types";
import { InlineRunsView } from "../InlineRunsView";
import { lockedAttrs } from "../../plugin/locked";

const TAG = { h1, h2, h3, h4, h5, h6 } as const;

export const HeadingView = view<{ block: HeadingBlock }>(({ props }) => ({
  shouldUpdate(next) {
    return next.block !== props().block;
  },
  render() {
    const b = props().block;
    const tag = TAG[b.type];
    tag(
      { "data-block-id": b.id, "data-block-kind": b.type, class: `ce-block ce-${b.type}`, ...lockedAttrs(b) },
      () => {
        InlineRunsView({ runs: b.runs });
      },
    );
  },
}));
