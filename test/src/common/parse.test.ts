import { expect } from "chai";
import { parseWithRecovery } from "../../../src/common/parse";

const parse = (text: string) => parseWithRecovery(text.split("\n"), false);

describe("parseWithRecovery", () => {
  it("returns no errors for a valid script", () => {
    const [node, errors] = parse("vim9script\nvar x = 1\nx += 1\n");
    expect(errors).to.deep.equal([]);
    expect(node!.body.length).to.equal(3);
  });

  it("reports every error and keeps parsing", () => {
    const [node, errors] = parse("let x = (\necho 1\nfoobar baz\necho 2\n");
    expect(errors.map((e) => e.line)).to.deep.equal([0, 2]);
    expect(errors[1].message).to.match(/^E492: Not an editor command/);
    expect(node!.body.length).to.equal(2);
  });

  it("opens the block of a failing block command", () => {
    const [, errors] = parse("if (\n  echo 1\nendif\nwhile [\nendwhile\n");
    expect(errors.map((e) => e.line)).to.deep.equal([0, 3]);
  });

  it("reports blocks that are not closed at their start", () => {
    const [node, errors] = parse("function! F()\n  if 1\n    echo 1\n");
    expect(errors.map((e) => [e.line, e.message])).to.deep.equal([
      [1, "E171: Missing :endif"],
      [0, "E126: Missing :endfunction"],
    ]);
    expect(node!.body.length).to.equal(1);
  });

  it("recovers inside a Vim9 lambda block", () => {
    const [, errors] = parse("vim9script\nvar F = () => {\n  foobar baz\n}\necho 1\n");
    expect(errors.map((e) => [e.line, e.col])).to.deep.equal([[2, 2]]);
  });
});
