Gold context (from the instructions and stub only):
- verse(n: number): string returns verse n of the song, n from 1 (fly) to 8 (horse). verses(start: number, end: number): string returns verses start..end.
- Animals in order: fly, spider, bird, cat, dog, goat, cow, horse.
- Each verse starts with "I know an old lady who swallowed a <animal>."
- Second line by animal (none for the fly):
  spider: "It wriggled and jiggled and tickled inside her."
  bird: "How absurd to swallow a bird!"
  cat: "Imagine that, to swallow a cat!"
  dog: "What a hog, to swallow a dog!"
  goat: "Just opened her throat and swallowed a goat!"
  cow: "I don't know how she swallowed a cow!"
  horse: "She's dead, of course!" (the horse verse ends here: only these two lines)
- Then, for verses 2..7, one line per earlier animal, going back down to the fly: "She swallowed the <animal> to catch the <previous animal>." When the previous animal is the spider, the line is "She swallowed the bird to catch the spider that wriggled and jiggled and tickled inside her."
- Every verse except the horse ends with "I don't know why she swallowed the fly. Perhaps she'll die."
- Line structure is exactly as in the song text: one line per sentence above, each line ending in "\n"; in verses(), consecutive verses are separated by an empty line.
