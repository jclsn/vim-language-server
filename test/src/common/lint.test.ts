import { expect } from "chai";
import { lint } from "../../../src/common/lint";
import { parseWithRecovery } from "../../../src/common/parse";

const check = (text: string) => {
  const [node, errors] = parseWithRecovery(text.split("\n"), false);
  expect(errors).to.deep.equal([]);
  return lint(node).map((e) => [e.line, e.message.replace(/:.*/, "")]);
};

describe("lint", () => {
  it("reports :let in Vim9 script", () => {
    expect(check("vim9script\nlet x = 1\ndef F()\n  let y = 2\nenddef\n")).to.deep.equal([
      [1, "E1126"],
      [3, "E1126"],
    ]);
  });

  it("allows :let in a legacy function of a Vim9 script", () => {
    expect(check("vim9script\nfunction F()\n  let x = 1\n  echo s:x\nendfunction\n")).to.deep.equal([]);
  });

  it("reports :var in legacy script", () => {
    expect(check("var x = 1\nfunction F()\n  var y = 2\nendfunction\n")).to.deep.equal([
      [0, "E1124"],
      [2, "E1124"],
    ]);
  });

  it("allows :var in a :def function of a legacy script", () => {
    expect(check("def g:F()\n  var x = s:y\nenddef\nvim9cmd var z = 1\n")).to.deep.equal([]);
  });

  it("reports s: in Vim9 script", () => {
    expect(check("vim9script\necho s:x\nlegacy echo s:x\n")).to.deep.equal([[1, "E1268"]]);
  });
});
