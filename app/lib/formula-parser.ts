type TokenType = "number" | "operator" | "lparen" | "rparen" | "variable";

interface Token {
  type: TokenType;
  value: string;
}

interface ASTNode {
  type: "number" | "variable" | "binaryop";
  value?: number;
  name?: string;
  op?: string;
  left?: ASTNode;
  right?: ASTNode;
}

function tokenize(formula: string): Token[] {
  const normalized = formula.replace(/,/g, ".");
  const tokens: Token[] = [];
  let i = 0;

  while (i < normalized.length) {
    const char = normalized[i];

    if (char === " ") {
      i++;
      continue;
    }

    if (char === "C" || char === "c") {
      tokens.push({ type: "variable", value: "C" });
      i++;
      continue;
    }

    if (char === "(") {
      tokens.push({ type: "lparen", value: "(" });
      i++;
      continue;
    }

    if (char === ")") {
      tokens.push({ type: "rparen", value: ")" });
      i++;
      continue;
    }

    if ("+-*/".includes(char)) {
      tokens.push({ type: "operator", value: char });
      i++;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      let num = "";
      while (i < normalized.length && /[0-9.]/.test(normalized[i])) {
        num += normalized[i];
        i++;
      }
      tokens.push({ type: "number", value: num });
      continue;
    }

    throw new Error(`Carácter inesperado en fórmula: '${char}' en posición ${i}`);
  }

  return tokens;
}

function parseExpression(tokens: Token[], pos: { i: number }): ASTNode {
  let node = parseTerm(tokens, pos);

  while (pos.i < tokens.length && tokens[pos.i].type === "operator" &&
    (tokens[pos.i].value === "+" || tokens[pos.i].value === "-")) {
    const op = tokens[pos.i].value;
    pos.i++;
    const right = parseTerm(tokens, pos);
    node = { type: "binaryop", op, left: node, right };
  }

  return node;
}

function parseTerm(tokens: Token[], pos: { i: number }): ASTNode {
  let node = parseFactor(tokens, pos);

  while (pos.i < tokens.length && tokens[pos.i].type === "operator" &&
    (tokens[pos.i].value === "*" || tokens[pos.i].value === "/")) {
    const op = tokens[pos.i].value;
    pos.i++;
    const right = parseFactor(tokens, pos);
    node = { type: "binaryop", op, left: node, right };
  }

  return node;
}

function parseFactor(tokens: Token[], pos: { i: number }): ASTNode {
  if (pos.i >= tokens.length) {
    throw new Error("Fórmula incompleta: token inesperado al final");
  }

  const token = tokens[pos.i];

  if (token.type === "number") {
    pos.i++;
    return { type: "number", value: parseFloat(token.value) };
  }

  if (token.type === "variable") {
    pos.i++;
    return { type: "variable", name: token.value };
  }

  if (token.type === "lparen") {
    pos.i++;
    const node = parseExpression(tokens, pos);
    if (pos.i >= tokens.length || tokens[pos.i].type !== "rparen") {
      throw new Error("Falta paréntesis de cierre ')'");
    }
    pos.i++;
    return node;
  }

  throw new Error(`Token inesperado: ${token.value}`);
}

function evaluateAST(node: ASTNode, variables: Record<string, number>): number {
  switch (node.type) {
    case "number":
      return node.value!;
    case "variable":
      if (node.name === "C" || node.name === "c") {
        return variables["C"];
      }
      throw new Error(`Variable desconocida: ${node.name}`);
    case "binaryop": {
      const left = evaluateAST(node.left!, variables);
      const right = evaluateAST(node.right!, variables);
      switch (node.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/":
          if (right === 0) throw new Error("División por cero en fórmula");
          return left / right;
        default:
          throw new Error(`Operador desconocido: ${node.op}`);
      }
    }
    default:
      throw new Error("Nodo AST inválido");
  }
}

export function evaluateFormula(formula: string, costPrice: number): number {
  if (!formula || formula.trim() === "") {
    return costPrice;
  }

  const tokens = tokenize(formula);
  if (tokens.length === 0) return costPrice;

  const pos = { i: 0 };
  const ast = parseExpression(tokens, pos);

  if (pos.i < tokens.length) {
    throw new Error(`Token inesperado al final de la fórmula: ${tokens[pos.i].value}`);
  }

  return evaluateAST(ast, { C: costPrice });
}

export function applyRounding(
  price: number,
  roundingType: string,
  roundingCustom?: number | null
): number {
  switch (roundingType) {
    case "none":
      return Math.round(price * 100) / 100;
    case "0.95": {
      const base = Math.floor(price);
      return base + 0.95 >= price + 0.05 ? base + 0.95 : base + 1.95;
    }
    case "0.99": {
      const base = Math.floor(price);
      return base + 0.99 >= price + 0.01 ? base + 0.99 : base + 1.99;
    }
    case "custom": {
      if (roundingCustom == null) return Math.round(price * 100) / 100;
      const base = Math.floor(price);
      const decimalPart = roundingCustom % 1;
      return base + decimalPart >= price ? base + decimalPart : base + 1 + decimalPart;
    }
    default:
      return Math.round(price * 100) / 100;
  }
}
