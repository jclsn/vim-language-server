import { expect } from "chai";
import { handleParse } from "../../../src/common/util";

describe("parser", () => {
  it("parses Vim9 script", async () => {
    const [node] = await handleParse("vim9script\nvar x = 1\n");
    expect(node).to.not.equal(null);
  });
});
