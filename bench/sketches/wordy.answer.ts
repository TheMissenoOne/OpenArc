(question) => {
  const tokens: string[] = arc.hole<string[]>("the tokens of the problem in question (numbers and operation words), rejecting questions that are not math word problems");
  let result: number = arc.hole<number>("the number the problem starts with, from tokens");
  arc.hole("apply the remaining operations in tokens to result from left to right, rejecting unsupported operations and invalid syntax");
  return result;
}
