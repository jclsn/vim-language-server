import { INode, StringReader, VimLParser } from "../lib/vimparser";

export interface IParseError {
  message: string;
  // 0-based
  line: number;
  col: number;
}

const NODE_FUNCTION = 4;
const NODE_IF = 13;
const NODE_WHILE = 17;
const NODE_FOR = 19;
const NODE_TRY = 23;
const NODE_IDENTIFIER = 86;
const NODE_LAMBDA = 92;
const NODE_DEF = 101;
const NODE_BLOCK = 111;
const NODE_CLASS = 113;
const NODE_INTERFACE = 115;
const NODE_ENUM = 117;

const errorPattern = /^vimlparser:\s*([\s\S]*?):\s*line\s*([0-9]+)\s*col\s*([0-9]+)$/;

// error for a block that is not closed, reported at the start of the block
const missingEnd: Record<number, string> = {
  [NODE_FUNCTION]: "E126: Missing :endfunction",
  [NODE_DEF]: "E1057: Missing :enddef",
  [NODE_IF]: "E171: Missing :endif",
  [NODE_WHILE]: "E170: Missing :endwhile",
  [NODE_FOR]: "E170: Missing :endfor",
  [NODE_TRY]: "E600: Missing :endtry",
  [NODE_BLOCK]: "E1026: Missing }",
  [NODE_CLASS]: "E1101: Missing :endclass",
  [NODE_INTERFACE]: "E1101: Missing :endinterface",
  [NODE_ENUM]: "E1101: Missing :endenum",
};

// commands that start a block, with the node used when the command fails
const blockCommands: Record<string, () => Partial<INode>> = {
  if: () => ({ type: NODE_IF, elseif: [], _else: undefined }),
  while: () => ({ type: NODE_WHILE }),
  for: () => ({ type: NODE_FOR, list: [] }),
  try: () => ({ type: NODE_TRY, catch: [] }),
  function: () => ({ type: NODE_FUNCTION, rlist: [], default_args: [] }),
  def: () => ({ type: NODE_DEF, rlist: [], default_args: [], attr: {} }),
  class: () => ({ type: NODE_CLASS, implements: [] }),
  interface: () => ({ type: NODE_INTERFACE }),
  enum: () => ({ type: NODE_ENUM, enumvalues: [], implements: [] }),
};

function toParseError(error: any): IParseError | undefined {
  const m = typeof error === "string" ? error.match(errorPattern) : null;
  if (!m) {
    return;
  }
  return {
    message: m[1],
    line: Math.max(parseInt(m[2], 10) - 1, 0),
    col: Math.max(parseInt(m[3], 10) - 1, 0),
  };
}

// Skip to the start of the line after "lnum" (1-based), at least one line.
function skipLine(reader: StringReader, start: number, lnum: number) {
  const len = reader.buf.length;
  if (reader.i <= start) {
    reader.i = start;
    while (reader.i < len && reader.buf[reader.i] !== "<EOL>") {
      reader.i += 1;
    }
    reader.i += 1;
  }
  while (reader.i < len && reader.pos[reader.i][0] <= lnum) {
    reader.i += 1;
  }
}

/*
 * Parse with error recovery: an error skips the rest of the line and the
 * parser continues with the next one.  A block command that fails, like an
 * :if with an invalid condition, still opens the block, so that the end of
 * the block gives no extra error.
 */
export function parseWithRecovery(lines: string[], isNeovim: boolean): [INode | null, IParseError[]] {
  const errors: IParseError[] = [];
  const reader = new StringReader(lines);
  const parser = new VimLParser(isNeovim);
  const parseOneCmd = parser.parse_one_cmd;

  parser.parse_one_cmd = function() {
    const start = this.reader.i;
    const depth = this.context.length;
    try {
      parseOneCmd.call(this);
    } catch (e) {
      const error = toParseError(e);
      if (!error) {
        throw e;
      }
      errors.push(error);
      // drop lambdas that were not closed
      while (this.context.length > depth && this.context[0].type === NODE_LAMBDA) {
        this.context.shift();
      }
      const cmd = this.ea && this.ea.cmd;
      if (this.context.length === depth && cmd && blockCommands[cmd.name]) {
        const node = {
          pos: this.ea.cmdpos,
          ea: this.ea,
          body: [],
          left: { type: NODE_IDENTIFIER, value: "", pos: this.ea.cmdpos },
          ...blockCommands[cmd.name](),
        } as INode;
        this.context[0].body.push(node);
        this.context.unshift(node);
      }
      skipLine(this.reader, start, error.line + 1);
    }
  };

  try {
    const node = parser.parse(reader);
    return [node, errors];
  } catch (e) {
    const error = toParseError(e);
    if (!error || !parser.context || !parser.context.length) {
      errors.push(error || { message: `${e}`, line: 0, col: 0 });
      return [null, errors];
    }
    // unclosed blocks at the end of the file
    const open = parser.context.filter((node) => missingEnd[node.type]);
    if (open.length) {
      open.forEach((node) => {
        errors.push({
          message: missingEnd[node.type],
          line: Math.max(node.pos.lnum - 1, 0),
          col: Math.max(node.pos.col - 1, 0),
        });
      });
    } else {
      errors.push(error);
    }
    return [parser.context[parser.context.length - 1], errors];
  }
}
