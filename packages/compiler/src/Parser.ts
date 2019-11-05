import {Token} from './Lexer';

/**
 * The type parameter `A` is the type of the AST nodes produced by the Grammar.
 */
export type Grammar<A> = {
  // TODO: see if I can get rid of `any` type here.
  [symbolName: string]:
    | Expression
    | [Expression, (result: any) => A]
    | [Expression, (result: any) => A, () => never];
};

interface ExpressionOperators {
  // TODO: consider writing these like this instead:
  // foo['?']
  // baz['+']
  // bar['*']

  optional: Expression;

  plus: Expression;

  star: Expression;
}

type Expression = TerminalSymbol | NonTerminalSymbol;

type TerminalSymbol = {
  kind: 'TOKEN';
  name: string;
  predicate?: (contents: string) => boolean;
} & ExpressionOperators;

type AndExpression = {
  kind: 'AND';
  expression: Expression;
};

type ChoiceExpression = {
  kind: 'CHOICE';
  expressions: Array<Expression>;
} & ExpressionOperators;

type NotExpression = {
  kind: 'NOT';
  expression: Expression;
};

type OptionalExpression = {
  kind: 'OPTIONAL';
  expression: Expression;
};

type PlusExpression = {
  kind: 'PLUS';
  expression: Expression;
};

type SequenceExpression = {
  kind: 'SEQUENCE';
  expressions: Array<Expression>;
} & ExpressionOperators;

type StarExpression = {
  kind: 'STAR';
  expression: Expression;
};

type SymbolReference = string;

type NonTerminalSymbol =
  | AndExpression
  | ChoiceExpression
  | NotExpression
  | OptionalExpression
  | PlusExpression
  | SequenceExpression
  | StarExpression
  | SymbolReference;

/**
 * Packrat PEG parser.
 *
 * The type parameter, `A` is the type of AST nodes returned by the production
 * functions in the Grammar.
 */
export default class Parser<A> {
  private _grammar: Grammar<A>;
  private _isIgnored: (token: Token) => boolean;

  // TODO: better types
  private _errorIndex: any;
  private _errorStack: any;
  private _parseStack: any;

  constructor(grammar: Grammar<A>, isIgnored: (token: Token) => boolean) {
    this._grammar = grammar;
    this._isIgnored = isIgnored;

    // Remember rightmost index.
    // this._index = 0;
    this._errorIndex = 0;
    this._errorStack = [];
    this._parseStack = [];

    if (!Object.keys(grammar).length) {
      throw new Error('Grammar must have at least one rule');
    }
  }

  parse(iterator: Generator<Token, Token>): A | null {
    const {done, value} = iterator.next();

    if (done) {
      // TODO: Let caller decide whether empty input should be a hard error or not?
      return null;
    }

    let startToken = this._isIgnored(value) ? this.next(value) : value;

    if (!startToken) {
      return null;
    }

    const rules = Object.keys(this._grammar);

    const startRule = rules[0];

    const maybe = this.evaluate(startRule, startToken);

    if (maybe) {
      const [result, next] = maybe;

      if (this.next(next) !== null) {
        // TODO report error stack here too?
        throw new Error('Failed to consume all input');
      }

      return result;
    }

    // Reconstruct input from tokens.
    let input = '';
    let token: Token | undefined = startToken;
    while (token) {
      input += token.contents;
      token = token.next;
    }

    // Derive line and column information from input.
    let column = 1;
    let line = 1;

    for (let i = 0; i < input.length; i++) {
      if (i === this._errorIndex) {
        break;
      }

      const c = input[i];

      if (c === '\r') {
        column = 1;
        line++;

        if (input[i + 1] === '\n') {
          i++;
        }
      } else if (c === '\n') {
        column = 1;
        line++;
      } else {
        column++;
      }
    }

    throw new Error(
      'Parse error:\n' +
        '\n' +
        `  Expected: ${this._errorStack[this._errorStack.length - 1]}\n` +
        '\n' +
        `  Parsing: ${this._errorStack.join(' \u00bb ')}\n` +
        '\n' +
        `  At: index ${this._errorIndex} (line ${line}, column ${column})\n` +
        '\n' +
        excerpt(input, line, column) +
        '\n',
    );
  }

  private evaluate(
    start: Expression,
    current: Token | null,
  ): [A, Token | null] | null {
    const rule = typeof start === 'string' ? this._grammar[start] : start;

    const index = current ? current.index : 0;

    if (typeof start === 'string') {
      this._parseStack.push(start);
    }

    if (!rule) {
      throw new Error(
        `Failed to resolve symbol reference ${JSON.stringify(rule)}`,
      );
    }

    const [expression, production, onFailure] = Array.isArray(rule)
      ? rule
      : [rule, identity];

    // TODO: instead of esoteric label and break statements, just repeat code
    outer: {
      if (!current) {
        break outer;
      }

      if (typeof expression === 'string') {
        const maybe = this.evaluate(expression, current);

        if (maybe) {
          const [result, next] = maybe;

          // TODO: refactor to avoid this repetition
          this._parseStack.pop();
          return [production(result), next];
        }
      } else {
        switch (expression.kind) {
          case 'AND':
            // TODO
            break;

          case 'CHOICE':
            {
              let next: Token | null = current;

              for (let i = 0; i < expression.expressions.length; i++) {
                let result;

                const maybe = this.evaluate(expression.expressions[i], next);

                if (maybe) {
                  [result, next] = maybe;

                  this._parseStack.pop();
                  return [production(result), next];
                }
              }
            }
            break;

          case 'NOT':
            // TODO
            break;

          case 'OPTIONAL':
            {
              const maybe = this.evaluate(expression.expression, current);

              this._parseStack.pop();

              if (maybe) {
                const [result, next] = maybe;

                return [production(result), next];
              } else {
                return [production(undefined), current];
              }
            }
            break;

          case 'PLUS':
            {
              const results = [];
              let next: Token | null = current;

              while (true) {
                const maybe = this.evaluate(expression.expression, next);
                let result;

                if (maybe) {
                  [result, next] = maybe;

                  results.push(result);
                } else {
                  break;
                }
              }

              if (results.length) {
                this._parseStack.pop();
                return [production(results), next];
              }
            }
            break;

          case 'SEQUENCE': {
            // TODO: report rightmost error
            const results = [];
            let next: Token | null = current;

            for (let i = 0; i < expression.expressions.length; i++) {
              const maybe = this.evaluate(expression.expressions[i], next);
              let result;

              if (maybe) {
                [result, next] = maybe;

                results.push(result);
              } else {
                break outer;
              }
            }

            this._parseStack.pop();
            return [production(results), next];
          }

          case 'STAR':
            // TODO
            break;

          case 'TOKEN':
            if (current && current.name === expression.name) {
              if (
                expression.predicate &&
                !expression.predicate(current.contents)
              ) {
                break outer;
              }

              this._parseStack.pop();
              return [production(current.contents), this.next(current)];
            }
            break;
        }
      }
    }

    if (index > this._errorIndex) {
      this._errorIndex = index;
      this._errorStack = [...this._parseStack];
    }

    if (onFailure) {
      onFailure();
    }

    this._parseStack.pop();
    return null;
  }

  /**
   * Returns the next lexical (non-ignored) Token after `token`, or
   * `null` if there isn't one.
   */
  private next(token: Token | null): Token | null {
    let current = token;

    while (true) {
      current = (current && current.next) || null;

      if (!current) {
        return null;
      }

      // TODO: may want to memoize list of non-ignored tokens so that we don't
      // have to repeatedly scan through ignored tokens.
      if (this._isIgnored(current)) {
        continue;
      }

      return current;
    }
  }
}

/**
 * "And" predicate.
 *
 * Succeeds when `expression` succeeds, but does not consume any input.
 */
export function and(expression: Expression): AndExpression {
  return {
    expression,
    kind: 'AND',
  };
}

/**
 * Ordered choice.
 *
 * Tries each expression in `expressions`, succeeding as soon as encountering a
 * successful expression. After each unsuccessful match, backtracks.
 */
export function choice(...expressions: Array<Expression>): ChoiceExpression {
  return withProperties({
    expressions,
    kind: 'CHOICE',
  });
}

function excerpt(text: string, line: number, column: number): string {
  let output = '';

  const lines = text.split(/\r\n?|\n/g);

  const gutter = (line + 2).toString().length;

  for (let i = line - 3; i < line + 2; i++) {
    if (i >= 0 && i < lines.length) {
      if (i === line - 1) {
        output += '> ';
      } else {
        output += '  ';
      }

      output += `${(i + 1).toString().padStart(gutter)} | ${lines[i]}\n`;

      if (i === line - 1) {
        output += `  ${' '.repeat(gutter)} | ${' '.repeat(column - 1)}^\n`;
      }
    }
  }

  return output;
}

/**
 * Identity function that returns its argument unmodified.
 */
function identity<T extends any>(id: T): T {
  return id;
}

/**
 * "Not" predicate.
 *
 * Succeeds when `expression` does not succeed, but does not consume any input.
 */
export function not(expression: Expression): NotExpression {
  return {
    expression,
    kind: 'NOT',
  };
}

/**
 * Optional combinator.
 *
 * Succeeds when 0 or 1 repetitions of `expression` succeed.
 */
export function optional(expression: Expression): OptionalExpression {
  return {
    expression,
    kind: 'OPTIONAL',
  };
}

/**
 * Kleene plus.
 *
 * Succeeds when 1 or more repetitions of `expression` succeed.
 */
export function plus(expression: Expression): PlusExpression {
  return {
    expression,
    kind: 'PLUS',
  };
}

/**
 * Sequence.
 *
 * Tries each expression in `expressions`, succeeding if all expressions are
 * successful. Fails on any unsuccessful match.
 */
export function sequence(
  ...expressions: Array<Expression>
): SequenceExpression {
  return withProperties({
    expressions,
    kind: 'SEQUENCE',
  });
}

/**
 * Kleene star.
 *
 * Succeeds when 0 or more repetitions of `expression` succeed.
 */
export function star(expression: Expression): StarExpression {
  return {
    expression,
    kind: 'STAR',
  };
}

/**
 * Represents a terminal symbol of the type identified by `tokenName`.
 *
 * The optional `predicate` function allows an arbitrary check of the token
 * contents to be specified to gate success.
 */
export function t(
  tokenName: string,
  predicate?: (contents: string) => boolean,
): TerminalSymbol {
  return withProperties({
    kind: 'TOKEN',
    name: tokenName,
    predicate,
  });
}

function withProperties<T extends unknown>(base: T): T & ExpressionOperators {
  Object.defineProperties(base, {
    optional: {
      get() {
        return withProperties(optional(base as Expression));
      },
    },

    plus: {
      get() {
        return withProperties(plus(base as Expression));
      },
    },

    star: {
      get() {
        return withProperties(star(base as Expression));
      },
    },
  });

  return base as T & ExpressionOperators;
}
