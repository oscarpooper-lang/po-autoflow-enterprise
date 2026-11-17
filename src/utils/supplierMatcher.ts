import type { CompanyAlias, CompanyCacheEntry } from '../types';

export interface SupplierMatchCandidateResult {
  company: CompanyCacheEntry | null;
  score: number;
  matchedBy: 'alias' | 'exact_name' | 'exact_email' | 'fuzzy_name' | 'none';
  sameEmailMatches: CompanyCacheEntry[];
}

export function splitEmailAddresses(raw?: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[,;]+/)) {
    const clean = part.trim().toLowerCase();
    if (clean && clean.includes('@') && !out.includes(clean)) {
      out.push(clean);
    }
  }
  return out;
}

export function normalizeCompanyKey(raw?: string | null): string {
  if (!raw) return '';
  let s = raw
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .toLowerCase()
    .trim();

  // Strip common Thai & English head office / branch tags
  s = s
    .replace(/\(?\s*สำนักงานใหญ่\s*\)?/g, ' ')
    .replace(/\(?\s*head\s*office\s*\)?/gi, ' ')
    .replace(/สาขา(?:ที่)?\s*\d*/g, ' ')
    .replace(/\bbranch\s*(?:no\.?\s*)?\d*\b/gi, ' ')
    .trim();

  // Strip Thai legal prefixes
  const thaiPrefixes = [
    'บริษัทจำกัด(มหาชน)',
    'บริษัทจำกัด (มหาชน)',
    'บริษัทมหาชนจำกัด',
    'บริษัท มหาชน จำกัด',
    'บริษัท',
    'บจก.',
    'บจก',
    'บ.จำกัด',
    'ห้างหุ้นส่วนจำกัด',
    'ห้างหุ้นส่วนสามัญ',
    'หจก.',
    'หจก',
    'หสน.',
    'หสน',
  ];
  for (const prefix of thaiPrefixes) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length).trim();
      break;
    }
  }

  // Strip chained Thai legal suffixes
  const thaiSuffixes = [
    'จำกัด (มหาชน)',
    'จำกัด(มหาชน)',
    'มหาชน จำกัด',
    'มหาชนจำกัด',
    '(มหาชน)',
    'มหาชน',
    'จำกัด',
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of thaiSuffixes) {
      if (s.endsWith(suf)) {
        s = s.slice(0, s.length - suf.length).trim();
        changed = true;
        break;
      }
    }
  }

  // Strip chained English / international legal suffixes
  const engSuffixes = [
    'public company limited',
    'limited partnership',
    'ltd., part.',
    'ltd. part.',
    'ltd part',
    'company limited',
    'co., ltd.',
    'co., ltd',
    'co. ltd.',
    'co. ltd',
    'co ltd',
    'pte. ltd.',
    'pte ltd',
    'pty. ltd.',
    'pty ltd',
    'sdn. bhd.',
    'sdn bhd',
    'gmbh & co. kg',
    'gmbh',
    'limited',
    'ltd.',
    'ltd',
    'corporation',
    'corp.',
    'corp',
    'incorporated',
    'inc.',
    'inc',
    'llc',
    'llp',
    'plc.',
    'plc',
    'pcl.',
    'pcl',
  ];
  let engChanged = true;
  while (engChanged) {
    engChanged = false;
    for (const suf of engSuffixes) {
      if (s.endsWith(suf)) {
        s = s.slice(0, s.length - suf.length).trim();
        engChanged = true;
        break;
      }
    }
  }

  return s
    .replace(/[.,\-–—()[\]{}'"/\\#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigramDiceSimilarity(aRaw: string, bRaw: string): number {
  const a = aRaw.replace(/\s+/g, '');
  const b = bRaw.replace(/\s+/g, '');
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.length < 2 || b.length < 2) {
    return a.includes(b) || b.includes(a) ? 85 : 0;
  }
  const gramsA = new Set<string>();
  const gramsB = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) gramsA.add(a.slice(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) gramsB.add(b.slice(i, i + 2));
  let inter = 0;
  for (const g of gramsA) {
    if (gramsB.has(g)) inter++;
  }
  return Math.round(((200 * inter) / (gramsA.size + gramsB.size)) * 10) / 10;
}

function scoreNamePair(queryClean: string, targetRaw?: string | null): number {
  const targetClean = normalizeCompanyKey(targetRaw);
  if (!queryClean || !targetClean) return 0;
  if (queryClean === targetClean) return 100;
  if (
    targetClean.length >= 4 &&
    queryClean.length >= 4 &&
    (targetClean.includes(queryClean) || queryClean.includes(targetClean))
  ) {
    const ratio = Math.min(queryClean.length, targetClean.length) / Math.max(queryClean.length, targetClean.length);
    return Math.round(Math.max(82, 85 + ratio * 13) * 10) / 10;
  }
  const qTokens = new Set(queryClean.split(' ').filter(Boolean));
  const tTokens = new Set(targetClean.split(' ').filter(Boolean));
  let tokenOverlap = 0;
  if (qTokens.size > 0 && tTokens.size > 0) {
    let common = 0;
    for (const tok of qTokens) {
      if (tTokens.has(tok)) common++;
    }
    tokenOverlap = (200 * common) / (qTokens.size + tTokens.size);
  }
  return Math.max(bigramDiceSimilarity(queryClean, targetClean), tokenOverlap);
}

function isUsableProofingNote(notes?: string | null): boolean {
  if (!notes) return false;
  const trimmed = notes.trim();
  if (trimmed.length < 3) return false;
  const low = trimmed.toLowerCase();
  return (
    !low.startsWith('auto-learned') &&
    !low.startsWith('auto_learned') &&
    !low.startsWith('synced via') &&
    !low.startsWith('preferred tier')
  );
}

export function findCompaniesSharingEmail(
  emailInput: string,
  companies: CompanyCacheEntry[]
): CompanyCacheEntry[] {
  const queryEmails = splitEmailAddresses(emailInput);
  if (queryEmails.length === 0) return [];
  return companies.filter((c) => {
    if (!c.active) return false;
    const compEmails = splitEmailAddresses(c.email);
    return queryEmails.some((qe) => compEmails.includes(qe));
  });
}

/**
 * Matches any combination of detected/typed company names and extracted/typed emails
 * against Google Sheets directory entries (Primary Name, English/Alt Name, Proofing/Notes,
 * and Learned Aliases), including multiple companies sharing the same email.
 */
export function matchSupplierAgainstDirectory(
  nameInputs: Array<string | null | undefined>,
  emailInputs: Array<string | null | undefined>,
  companies: CompanyCacheEntry[],
  aliases: CompanyAlias[] = []
): SupplierMatchCandidateResult {
  const activeCompanies = companies.filter((c) => c.active);
  const cleanNames = Array.from(
    new Set(
      nameInputs
        .map((n) => (n || '').trim())
        .filter((n) => n.length >= 2)
    )
  );
  const queryEmails = Array.from(
    new Set(emailInputs.flatMap((e) => splitEmailAddresses(e)))
  );

  const sameEmailMatches =
    queryEmails.length > 0
      ? activeCompanies.filter((c) => {
          const compEmails = splitEmailAddresses(c.email);
          return queryEmails.some((qe) => compEmails.includes(qe));
        })
      : [];
  const sameEmailIds = new Set(sameEmailMatches.map((c) => c.id));

  // 1. Direct custom alias lookup (adapts Thai/EN cleaned variants + alternative_name targets)
  for (const rawName of cleanNames) {
    const qClean = normalizeCompanyKey(rawName);
    if (!qClean) continue;
    for (const alias of aliases) {
      const aClean = normalizeCompanyKey(alias.alias);
      if (aClean && (aClean === qClean || bigramDiceSimilarity(aClean, qClean) >= 94)) {
        const canonClean = normalizeCompanyKey(alias.canonical_company_name);
        const target = activeCompanies.find(
          (c) =>
            normalizeCompanyKey(c.company_name) === canonClean ||
            (c.alternative_name && normalizeCompanyKey(c.alternative_name) === canonClean)
        );
        if (target) {
          return {
            company: target,
            score: 100,
            matchedBy: 'alias',
            sameEmailMatches,
          };
        }
      }
    }
  }

  // 2. Score every active Sheet company across Primary, Alternate, Proofing/Notes, and Same-Email overlap
  let bestCompany: CompanyCacheEntry | null = null;
  let bestScore = 0;
  let bestBy: SupplierMatchCandidateResult['matchedBy'] = 'none';

  for (const comp of activeCompanies) {
    let compBest = 0;
    for (const rawName of cleanNames) {
      const qClean = normalizeCompanyKey(rawName);
      if (!qClean) continue;
      compBest = Math.max(
        compBest,
        scoreNamePair(qClean, comp.company_name),
        scoreNamePair(qClean, comp.alternative_name),
        isUsableProofingNote(comp.notes) ? scoreNamePair(qClean, comp.notes) : 0
      );
    }

    const sharesEmail = sameEmailIds.has(comp.id);
    if (sharesEmail && compBest > 0) {
      compBest = Math.min(100, compBest + 14);
    } else if (sharesEmail && cleanNames.length === 0) {
      compBest = 99;
    } else if (sharesEmail && sameEmailMatches.length === 1) {
      compBest = Math.max(compBest, 98.5);
    } else if (sharesEmail) {
      compBest = Math.max(compBest, 88);
    }

    if (compBest > bestScore) {
      bestScore = compBest;
      bestCompany = comp;
      bestBy =
        compBest >= 99.9 && !sharesEmail
          ? 'exact_name'
          : sharesEmail
          ? 'exact_email'
          : 'fuzzy_name';
    }
  }

  if (!bestCompany || bestScore < 72) {
    if (sameEmailMatches.length > 0) {
      return {
        company: sameEmailMatches[0],
        score: sameEmailMatches.length === 1 ? 99 : 88,
        matchedBy: 'exact_email',
        sameEmailMatches,
      };
    }
    return {
      company: null,
      score: 0,
      matchedBy: 'none',
      sameEmailMatches,
    };
  }

  return {
    company: bestCompany,
    score: Math.round(bestScore * 10) / 10,
    matchedBy: bestBy,
    sameEmailMatches,
  };
}
