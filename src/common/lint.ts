import { INode } from "../lib/vimparser";
import { getChildren, hasModifier } from "./ast";
import { IParseError } from "./parse";

const NODE_TOPLEVEL = 1;
const NODE_FUNCTION = 4;
const NODE_LET = 9;
const NODE_IDENTIFIER = 86;
const NODE_LAMBDA = 92;
const NODE_DEF = 101;
const NODE_VAR = 103;
const NODE_VIM9SCRIPT = 107;
const NODE_BLOCK = 111;
const NODE_CLASS = 113;
const NODE_INTERFACE = 115;
const NODE_ENUM = 117;

// nodes whose body uses Vim9 syntax
const vim9Bodies: Record<number, boolean> = {
  [NODE_DEF]: true,
  [NODE_LAMBDA]: true,
  [NODE_BLOCK]: true,
  [NODE_CLASS]: true,
  [NODE_INTERFACE]: true,
  [NODE_ENUM]: true,
};

/*
 * Errors that Vim gives for valid syntax used in the wrong kind of script:
 * :let in Vim9 script, :var in legacy script and s: in a Vim9 script.
 */
export function lint(root: INode | null): IParseError[] {
  const errors: IParseError[] = [];
  if (!root) {
    return errors;
  }
  const add = (node: INode, message: string) => {
    if (node.pos) {
      errors.push({
        message,
        line: Math.max(node.pos.lnum - 1, 0),
        col: Math.max(node.pos.col - 1, 0),
      });
    }
  };
  let vim9script = false;

  const visit = (node: INode, inVim9: boolean) => {
    let vim9 = inVim9;
    if (hasModifier(node, "vim9cmd")) {
      vim9 = true;
    } else if (hasModifier(node, "legacy")) {
      vim9 = false;
    }
    if (node.type === NODE_LET && vim9) {
      add(node, "E1126: Cannot use :let in Vim9 script");
    } else if (node.type === NODE_VAR && !vim9) {
      // :final is :finally in legacy script
      add(node, `E1124: ":var" cannot be used in legacy Vim script`);
    } else if (node.type === NODE_IDENTIFIER && vim9 && vim9script && /^s:/.test(node.value)) {
      add(node, `E1268: Cannot use s: in Vim9 script: ${node.value}`);
    }
    // a legacy lambda {args -> expr} has no "rettype"
    const vim9Lambda = node.type === NODE_LAMBDA && node.rettype !== undefined;
    if (node.type === NODE_FUNCTION) {
      getChildren(node).forEach((child) => visit(child, child === node.left ? vim9 : false));
    } else if (vim9Lambda || (node.type !== NODE_LAMBDA && vim9Bodies[node.type])) {
      getChildren(node).forEach((child) => visit(child, true));
    } else {
      getChildren(node).forEach((child) => visit(child, vim9));
    }
  };

  if (root.type === NODE_TOPLEVEL) {
    root.body.forEach((node) => {
      if (node.type === NODE_VIM9SCRIPT) {
        vim9script = true;
      }
      visit(node, vim9script);
    });
  } else {
    visit(root, false);
  }
  return errors;
}
