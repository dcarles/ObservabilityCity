// What a town calls one island (town.yaml groupLabel: Pillar, Team, Domain ...), in the forms the interface needs. Every word on screen that names an
// island's group comes from here, so a town that says Team never reads Pillar.

export const DEFAULT_GROUP_LABEL = 'Pillar'

export interface GroupWords {
  /** As a title or at the start of a sentence: "Pillar". */
  one: string
  /** "Pillars". */
  many: string
  /** Inside a sentence: "pillar". A label in capitals (an acronym such as BU) keeps them. */
  lower: string
  /** "pillars". */
  lowerMany: string
}

const plural = (word: string): string => (/s$/i.test(word) ? word : `${word}s`)
const lowerFirst = (word: string): string => (word.length > 1 && word[1] === word[1].toUpperCase() && word[1] !== word[1].toLowerCase() ? word : word.charAt(0).toLowerCase() + word.slice(1))

/** The words for a town's label. An empty or missing label is the default, Pillar, so a town that sets none reads as it always did. */
export function groupWords(label: string | null | undefined): GroupWords {
  const raw = (label ?? '').trim() || DEFAULT_GROUP_LABEL
  const one = raw.charAt(0).toUpperCase() + raw.slice(1)
  return { one, many: plural(one), lower: lowerFirst(one), lowerMany: plural(lowerFirst(one)) }
}

/** Fills the {group} ("pillar"), {Group} ("Pillar"), {groups} and {Groups} holes of a text with the town's words. */
export function withGroupWords(text: string, words: GroupWords): string {
  return text.replace(/\{(group|Group|groups|Groups)\}/g, (_m, k: string) => (k === 'group' ? words.lower : k === 'Group' ? words.one : k === 'groups' ? words.lowerMany : words.many))
}
