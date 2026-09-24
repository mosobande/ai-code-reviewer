import assert from "node:assert/strict";
import { test } from "node:test";
import { renderInertModelText } from "../model-text.ts";

test("model text cannot issue mentions, links, HTML, or GitLab commands", () => {
  const text = renderInertModelText("<b>@team</b> fixes #42 [click](https://example.test)\n/merge");
  assert.doesNotMatch(text, /<b>|@team|fixes #42|\[click\]\(https:|\n\/merge/);
  assert.match(text, /&lt;b&gt;/);
});

test("model text rejects controls", () => {
  assert.throws(() => renderInertModelText("bad\u0000text"), /controls/);
});
