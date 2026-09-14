export type Tier = 'green' | 'yellow' | 'red';

/**
 * A person's threat STATUS (this label) and the ZONE they were detected in
 * (shown separately, e.g. "Zone: red") both use red/yellow/green — showing
 * the same three color words for two different things is what makes "person
 * detected as red" and "zone: red" read as the same fact when they aren't
 * (a person can be a Confirmed Threat while standing in a green zone, if
 * their behavior alone was enough to escalate). This is the one wording for
 * threat status everywhere in the app — never re-derive "RED"/"YELLOW" text
 * for a tier locally, import this instead.
 */
export function threatStatusLabel(tier: Tier): string {
  return { green: 'Normal', yellow: 'Suspicious', red: 'Confirmed Threat' }[tier];
}

/** Matches the Badge component's `variant` prop. */
export function threatStatusVariant(tier: Tier): 'green' | 'yellow' | 'red' {
  return tier;
}
