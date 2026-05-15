// Name fixes for the Ligne Roset USA tariff PDF.
//
// The catalog font has a broken /ToUnicode cmap, so accented characters come
// back as U+FFFD (which then collapses to "?" when normalised). The Python
// parser ships a curated map of corrupted-form → real-form rewrites; we port
// it verbatim. If a future edition introduces a new accented name, add it
// here.

const NAME_FIXES = {
  // Seats / beds / sofas
  'AM?D?E': 'AMÉDÉE',
  '?LYS?E': 'ÉLYSÉE',
  'H?MICYCLE': 'HÉMICYCLE',
  'MO?L': 'MOÊL',
  'PA?PA?': 'PAÏPAÏ',
  'RUCH?': 'RUCHÉ',
  'SOUFFL?': 'SOUFFLÉ',
  'ENN?A': 'ENNÉA',
  'NA?A': 'NAÏA',
  'NA?F': 'NAÏF',
  'CAFF?': 'CAFFÉ',
  'PYL?': 'PYLÉ',
  'VALL?E BLANCHE': 'VALLÉE BLANCHE',
  'MINI TOGO ?': 'MINI TOGO ®',
  'TOGO ?': 'TOGO ®',
  'N?NUFAR': 'NÉNUFAR',
  'EP?E': 'ÉPÉE',
  '?PISODE': 'ÉPISODE',
  'FR?': 'FRÉ',
  'D?BOURGEOIS?E': 'DÉBOURGEOISÉE',
  'P?JAROS': 'PÁJAROS',
  'PLISS?': 'PLISSÉ',
  'ASTR?E': 'ASTRÉE',
  'APOG?E': 'APOGÉE',
  'D?T': 'DÔT',
  'RH?A': 'RHÉA',
  'ROS?': 'ROSÉ',
  'CIRCO / CIRCA': 'CIRCO / CIRCA',
};

const INLINE_NAME_FIXES = {
  'Am?d?e': 'Amédée',
  '?lys?e': 'Élysée',
  'H?micycle': 'Hémicycle',
  'Mo?l': 'Moêl',
  'Pa?pa?': 'Païpaï',
  'Ruch?': 'Ruché',
  'Souffl?': 'Soufflé',
  'Enn?a': 'Ennéa',
  'Na?a': 'Naïa',
  'Pyl?': 'Pylé',
  'Vall?e Blanche': 'Vallée Blanche',
};

/** Best-effort replacement of U+FFFD / "?" artifacts. */
export function replacePlaceholders(s) {
  if (s == null) return s;
  let out = String(s).replace(/�/g, '?');
  for (const [bad, good] of Object.entries(NAME_FIXES)) {
    out = out.split(bad).join(good);
  }
  for (const [bad, good] of Object.entries(INLINE_NAME_FIXES)) {
    out = out.split(bad).join(good);
  }
  return out;
}

export function slugify(s) {
  return String(replacePlaceholders(s) || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}
