import { INode, IPos, VimLParser } from "../lib/vimparser";
import { buildScopeIndex, IDecl, IOccurrence, IScope } from "../server/scope";
import { getChildren, hasModifier } from "./ast";
import { IParseError } from "./parse";

const NODE_TOPLEVEL = 1;
const NODE_EXCMD = 3;
const NODE_FUNCTION = 4;
const NODE_LET = 9;
const NODE_CALL = 78;
const NODE_DOT = 79;
const NODE_IDENTIFIER = 86;
const NODE_LAMBDA = 92;
const NODE_CONST = 94;
const NODE_DEF = 101;
const NODE_VAR = 103;
const NODE_FINAL = 104;
const NODE_VIM9SCRIPT = 107;
const NODE_CAST = 109;
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

// commands that cannot be shortened in Vim9 script, see ":help E1065"
const noShorten: Record<string, boolean> = {};
[
  "break", "catch", "continue", "else", "elseif", "endfor", "endif", "endtry", "endwhile", "finally",
  "finish", "return", "throw", "while", "abstract", "class", "const", "def", "endclass", "enddef",
  "endenum", "endinterface", "enum", "export", "final", "import", "interface", "public", "static",
  "this", "type", "var",
].forEach((name) => noShorten[name] = true);

// commands that do not exist in Vim9 script, see ":help E1100"
const notInVim9: Record<string, boolean> = {};
["append", "change", "insert", "k", "mode", "open", "t", "xit", "Print"].forEach((name) => notInVim9[name] = true);

// builtin types, see ":help vim9-types"
const builtinTypes: Record<string, boolean> = {};
[
  "any", "blob", "bool", "channel", "dict", "float", "func", "job", "list", "number", "object",
  "string", "tuple", "void",
].forEach((name) => builtinTypes[name] = true);

// names that need no declaration in Vim9 script
const predefined: Record<string, boolean> = {};
["true", "false", "null", "this", "super", "_"].forEach((name) => predefined[name] = true);

let builtinFunctions: Record<string, boolean>;

function isBuiltinFunction(name: string): boolean {
  if (!builtinFunctions) {
    builtinFunctions = {};
    ((VimLParser.prototype as any).builtin_functions || []).forEach((f: { name: string }) => {
      builtinFunctions[f.name] = true;
    });
  }
  return !!builtinFunctions[name];
}

/*
 * Errors for how a command is written, also for a command that failed to
 * parse: a shortened command in Vim9 script, :let in Vim9 script and :var
 * in legacy script.
 */
export function lintCommand(ea: any, vim9: boolean, lines: string[]): IParseError[] {
  const cmd = ea && ea.cmd;
  const pos: IPos = ea && ea.cmdpos;
  if (!cmd || !cmd.name || !pos || !pos.lnum) {
    return [];
  }
  const error = (message: string) => [{ message, line: pos.lnum - 1, col: Math.max(pos.col - 1, 0) }];
  const m = (lines[pos.lnum - 1] || "").slice(pos.col - 1).match(/^[a-zA-Z]+/);
  if (vim9 && noShorten[cmd.name] && m && m[0] !== cmd.name && cmd.name.indexOf(m[0]) === 0) {
    return error(`E1065: Command cannot be shortened: ${m[0]}`);
  }
  if (vim9 && cmd.name === "let") {
    return error("E1126: Cannot use :let in Vim9 script");
  }
  if (!vim9 && cmd.name === "var") {
    return error(`E1124: ":var" cannot be used in legacy Vim script`);
  }
  return [];
}

const isBefore = (a: IPos, b: IPos) => a.lnum < b.lnum || (a.lnum === b.lnum && a.col < b.col);

/*
 * Errors that Vim gives for valid syntax used in the wrong way:
 * - :let in Vim9 script, :var in legacy script and s: in a Vim9 script
 * - declarations without a type or value, declared twice and unknown types
 * - commands that cannot be shortened or do not exist in Vim9 script
 * - variables that are not declared in a Vim9 script
 *
 * "lines" is the text, to see how a command was written.
 */
export function lint(root: INode | null, lines: string[] = []): IParseError[] {
  const errors: IParseError[] = [];
  if (!root) {
    return errors;
  }
  const add = (pos: IPos, message: string) => {
    if (pos && pos.lnum) {
      errors.push({
        message,
        line: Math.max(pos.lnum - 1, 0),
        col: Math.max(pos.col - 1, 0),
      });
    }
  };
  const vim9script = root.type === NODE_TOPLEVEL && (root.body || []).some((n) => n.type === NODE_VIM9SCRIPT);

  const checkCommand = (node: INode) => {
    const cmd = node.ea && node.ea.cmd;
    const pos = node.ea && node.ea.cmdpos;
    if (!cmd || !cmd.name || !pos || !pos.lnum) {
      return;
    }
    lintCommand(node.ea, true, lines)
      .filter((e) => /^E1065/.test(e.message))
      .forEach((e) => errors.push(e));
    if (node.type === NODE_EXCMD && notInVim9[cmd.name]) {
      add(pos, `E1100: Command not supported in Vim9 script (missing :var?): ${node.str}`);
    }
  };

  const checkType = (pos: IPos, type: string | undefined) => {
    (type || "").replace(/<[^<>]*>|\b[a-z]\w*\b/g, (word) => {
      // only lower case names can be builtin types, classes start with upper case
      if (/^[a-z]/.test(word) && !builtinTypes[word]) {
        add(pos, `E1010: Type not recognized: ${word}`);
      }
      return word;
    });
  };

  const checkVim9 = (node: INode) => {
    checkCommand(node);
    if (node.type === NODE_VAR || node.type === NODE_FINAL || node.type === NODE_CONST) {
      const hasValue = !!node.op;
      if (node.type === NODE_VAR && !hasValue && !node.type_str) {
        add(node.pos, "E1022: Type or initialization required");
      } else if (node.type === NODE_FINAL && !hasValue) {
        add(node.pos, "E1125: Final requires a value");
      } else if (node.type === NODE_CONST && !hasValue) {
        add(node.pos, "E1021: Const requires a value");
      }
      [].concat(node.left || []).concat(node.list || []).forEach((n: INode) => checkType(n.pos, n.type_str));
    } else if (node.type === NODE_DEF) {
      (node.rlist || []).forEach((n) => checkType(n.pos, n.type_str));
      checkType(node.pos, node.attr && node.attr.return_type);
    } else if (node.type === NODE_CAST) {
      checkType(node.pos, node.type_str);
    } else if (node.type === NODE_IDENTIFIER && /^[la]:/.test(node.value)) {
      add(node.pos, `E1075: Namespace not supported: ${node.value}`);
    }
  };

  const visit = (node: INode, inVim9: boolean) => {
    let vim9 = inVim9;
    if (hasModifier(node, "vim9cmd")) {
      vim9 = true;
    } else if (hasModifier(node, "legacy")) {
      vim9 = false;
    }
    if (node.type === NODE_LET && vim9) {
      add(node.pos, "E1126: Cannot use :let in Vim9 script");
    } else if (node.type === NODE_VAR && !vim9) {
      // :final is :finally in legacy script
      add(node.pos, `E1124: ":var" cannot be used in legacy Vim script`);
    } else if (node.type === NODE_IDENTIFIER && vim9 && vim9script && /^s:/.test(node.value)) {
      add(node.pos, `E1268: Cannot use s: in Vim9 script: ${node.value}`);
    }
    if (vim9) {
      checkVim9(node);
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
    let inVim9 = false;
    root.body.forEach((node) => {
      if (node.type === NODE_VIM9SCRIPT) {
        inVim9 = true;
      }
      visit(node, inVim9);
    });
  } else {
    visit(root, false);
  }
  if (vim9script) {
    lintScopes(root, add);
  }
  return errors;
}

// the scope is in a function, which is compiled when it is called
function inFunction(scope: IScope | undefined): boolean {
  for (let s = scope; s; s = s.parent) {
    if (s.kind === "function") {
      return true;
    }
  }
  return false;
}

// Variables declared twice and variables that are not declared.
function lintScopes(root: INode, add: (pos: IPos, message: string) => void) {
  const index = buildScopeIndex(root);

  const checkDuplicates = (decls: IDecl[]) => {
    const seen: Record<string, boolean> = {};
    decls.forEach((d) => {
      const declares = d.vim9 && (d.statement === NODE_VAR || d.statement === NODE_FINAL || d.statement === NODE_CONST);
      if (!declares || d.name === "_") {
        return;
      }
      if (seen[d.name]) {
        add(d.pos, `E1017: Variable already declared: ${d.name}`);
      }
      seen[d.name] = true;
    });
  };
  const scopes: IScope[] = [index.script];
  index.occurrences.forEach((occ) => {
    for (let s: IScope | undefined = occ.scope; s; s = s.parent) {
      if (scopes.indexOf(s) === -1) {
        scopes.push(s);
      }
    }
  });
  scopes.forEach((s) => checkDuplicates(s.decls));

  index.occurrences.forEach((occ) => {
    if (!isUndeclared(occ)) {
      return;
    }
    const name = occ.node.value;
    if (inFunction(occ.scope)) {
      add(occ.node.pos, `E1001: Variable not found: ${name}`);
    } else {
      add(occ.node.pos, `E121: Undefined variable: ${name}`);
    }
  });
}

function isUndeclared(occ: IOccurrence): boolean {
  const { node, parent } = occ;
  const name: string = node.value;
  if (!occ.vim9 || typeof name !== "string" || !/^[a-z_]\w*$/.test(name) || predefined[name]) {
    return false;
  }
  // a function call, a member, or a declaration itself
  if (parent && ((parent.type === NODE_CALL && parent.left === node) || (parent.type === NODE_DOT && parent.right === node))) {
    return false;
  }
  if (/^null_/.test(name) || isBuiltinFunction(name)) {
    return false;
  }
  const compiled = inFunction(occ.scope);
  for (let s: IScope | undefined = occ.scope; s; s = s.parent) {
    const found = s.decls.filter((d) => d.name === name);
    if (found.some((d) => d.node === node)) {
      return false;
    }
    const visible = found.filter((d) => {
      if (d.kind !== "variable" && d.kind !== "member" && d.kind !== "import") {
        return true;
      }
      // script variables may be declared after a function that uses them
      return (s!.kind === "script" && compiled) || isBefore(d.pos, node.pos) || d.pos === node.pos;
    });
    if (visible.length) {
      return false;
    }
  }
  return true;
}
