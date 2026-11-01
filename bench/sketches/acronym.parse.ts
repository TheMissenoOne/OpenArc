(phrase) => {
  const words: string[] = arc.hole<string[]>("the words of phrase: hyphens and whitespace separate words, all other punctuation is removed");
  return words.map((word) => arc.hole<string>("the acronym letters contributed by word, upper-cased")).join("");
}
