// according to https://github.com/aadsm/jschardet
// This is a array of the most common encodings.
// Since, for example ISO-8859-1, isnt supported
// by jschardet, but files can encoded this way,
// we added this.
export let possibleEncodings: string[] =
[
  'windows-1252',
  'ISO-8859-7',
  'ISO-8859-1',
  'ISO-8859-2',
  'ASCII',
  'UTF-8'
];
