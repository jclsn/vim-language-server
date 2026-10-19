import { expect } from "chai";
import { TextDocument } from "vscode-languageserver-textdocument";
import { handleParse } from "../../../src/common/util";
import { getDiagnostics } from "../../../src/handles/diagnostic";

const diagnose = async (text: string) => {
  const doc = TextDocument.create("file:///test.vim", "vim", 1, text);
  const [, errors] = await handleParse(doc);
  return getDiagnostics(doc as any, errors);
};

describe("diagnostics", () => {
  it("covers the word at the error and sets the error code", async () => {
    const [d] = await diagnose("echo 1\n  foobar baz\n");
    expect(d.code).to.equal("E492");
    expect(d.range).to.deep.equal({
      start: { line: 1, character: 2 },
      end: { line: 1, character: 8 },
    });
  });

  it("reports one diagnostic per error", async () => {
    const list = await diagnose("let x = (\nfoobar\nfunction! F()\n");
    expect(list.map((d) => d.range.start.line)).to.deep.equal([0, 1, 2]);
  });
});
