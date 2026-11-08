// Work Order Intake: turns a pasted work-order email into a structured ticket.
// The parser (window.Intake) is plain functions with no DOM access, so it can be
// tested in Node. The UI code at the bottom only runs in a browser.
// All data is fictional (see ../shared/data.js).

(function (root) {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const titleCase = s => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
  const field = (value, status, note) => ({ value: value == null ? '' : value, status: value ? status : 'review', note: note || '' });

  // "Label: value" lines. Returns the first match for any of the labels.
  function labelled(text, labels) {
    const re = new RegExp('^[ \\t>*-]*(?:' + labels.map(esc).join('|') + ')\\s*(?:#|no\\.?|number)?\\s*[:\\-–]\\s*(.+)$', 'im');
    const m = text.match(re);
    return m ? m[1].trim() : '';
  }

  // Split "From:" / "Subject:" header lines off the top of the pasted text.
  function splitHeaders(raw) {
    const lines = raw.replace(/\r/g, '').split('\n');
    const head = {};
    let i = 0;
    while (i < lines.length && i < 8) {
      const m = lines[i].match(/^(from|subject|to|date|sent|cc)\s*:\s*(.*)$/i);
      if (m) { head[m[1].toLowerCase()] = m[2].trim(); i++; continue; }
      if (!lines[i].trim() && Object.keys(head).length === 0) { i++; continue; }
      break;
    }
    return { from: head.from || '', subject: head.subject || '', body: lines.slice(i).join('\n').trim() };
  }

  // ---------------------------------------------------------------- phones
  const PHONE_RE = /(?<![\w-])(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-](\d{4})(?![\w-])/g;
  const PHONE_RE_LOOSE = /(?<![\w-])(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?![\w-])/g;
  const fmtPhone = (a, b, c) => `(${a}) ${b}-${c}`;
  function normalizePhone(s) {
    const d = String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    return d.length === 10 ? fmtPhone(d.slice(0, 3), d.slice(3, 6), d.slice(6)) : clean(s);
  }
  function findPhones(text, exclude) {
    const out = [];
    const seen = new Set(exclude);
    for (const re of [PHONE_RE, PHONE_RE_LOOSE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const p = fmtPhone(m[1], m[2], m[3]);
        if (seen.has(p)) continue;
        seen.add(p);
        const before = text.slice(Math.max(0, m.index - 14), m.index).toLowerCase();
        let kind = '';
        if (/alt|other|second/.test(before)) kind = 'alt';
        else if (/cell|mobile|text/.test(before)) kind = 'cell';
        else if (/home/.test(before)) kind = 'home';
        else if (/work|office/.test(before)) kind = 'work';
        out.push({ number: p, kind, index: m.index });
      }
      if (out.length) break;
    }
    return out.sort((a, b) => a.index - b.index);
  }

  // ---------------------------------------------------------------- address
  const SUFFIX = 'St|Street|Ave|Avenue|Way|Dr|Drive|Ln|Lane|Rd|Road|Ct|Court|Blvd|Boulevard|Pl|Place|Ter|Terrace|Trl|Trail|Loop|Pkwy|Parkway|Cir|Circle|Hollow|Bend|Pass|Run|Row|Sq|Hwy|Highway|Crossing|Xing|Path|Pike|Hill|View';
  const STREET_RE = new RegExp('\\b(\\d{1,6}\\s+(?:[NSEW]\\.?\\s+)?(?:[A-Za-z][A-Za-z\'’-]*\\s+){0,3}(?:' + SUFFIX + ')\\b\\.?(?:,?\\s*(?:Apt|Unit|Suite|Ste|#)\\.?\\s*[\\w-]+)?)', 'i');
  function splitZip(s) {
    const m = s.match(/^(.*\S)[,\s]+(?:[A-Z]{2}\s+)?(\d{5})(?:-\d{4})?\s*$/);
    return m ? { street: m[1].replace(/[,\s]+$/, ''), zip: m[2] } : { street: s, zip: '' };
  }
  function findAddress(text) {
    const lab = labelled(text, ['Service address', 'Property address', 'Site address', 'Property', 'Address', 'Location', 'Service location']);
    if (lab && /\d/.test(lab)) {
      const { street, zip } = splitZip(lab);
      return { street: clean(street), zip, status: 'found' };
    }
    const m = text.match(STREET_RE);
    if (m) {
      const street = clean(m[1]).replace(/\b[a-z]/g, c => c.toUpperCase());
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
      const z = after.match(/^[,\s]*(?:[A-Za-z .]+,\s*)?(?:[A-Z]{2}\s*)?(\d{5})\b/);
      return { street, zip: z ? z[1] : '', status: 'found' };
    }
    return { street: '', zip: '', status: 'review' };
  }

  // ---------------------------------------------------------------- vendor & claim
  function findClaim(text, vendors) {
    for (const v of vendors) {
      if (!v.claimPrefix) continue;
      const p = v.claimPrefix.replace(/-$/, '');
      const re = new RegExp('\\b' + esc(p) + '[\\s-]?(\\d{5,})\\b', 'i');
      const m = text.match(re);
      if (m) return { claim: v.claimPrefix + m[1], vendor: v };
    }
    const lab = text.match(/claim\s*(?:#|no\.?|number)?\s*[:#]?\s*([A-Z]{1,4}-?\d{4,})\b/i);
    if (lab) return { claim: lab[1].toUpperCase(), vendor: null };
    return { claim: '', vendor: null };
  }
  function findVendor(from, text, claimVendor, vendors) {
    const fromL = from.toLowerCase();
    const textL = text.toLowerCase();
    let best = null, bestScore = 0;
    for (const v of vendors) {
      if (!v.claimPrefix) continue;
      const short = v.short.toLowerCase();
      let s = 0;
      if (fromL.includes(short)) s += 5;
      if (textL.includes(v.name.toLowerCase())) s += 4;
      else if (new RegExp('\\b' + esc(short) + '\\b').test(textL)) s += 2;
      if (claimVendor && claimVendor.id === v.id) s += 5;
      if (s > bestScore) { best = v; bestScore = s; }
    }
    const direct = vendors.find(v => !v.claimPrefix) || vendors[vendors.length - 1];
    return best ? { vendor: best, status: bestScore >= 4 ? 'found' : 'inferred' } : { vendor: direct, status: 'inferred' };
  }

  // ---------------------------------------------------------------- trade & equipment
  // [regex, trade, weight, display name]. Strong phrases are removed after scoring so
  // "water heater" never counts as "heat" and "dishwasher" never counts as "washer".
  const STRONG = [
    [/\bdish ?washers?\b/g, 'Appliance', 6, 'Dishwasher'],
    [/\bwater heaters?\b|\bhot water heaters?\b|\btankless\b/g, 'Plumbing', 6, 'Water heater'],
    [/\bgarbage disposals?\b|\bdisposals?\b/g, 'Plumbing', 5, 'Garbage disposal'],
    [/\bheat pumps?\b/g, 'HVAC', 6, 'Heat pump'],
    [/\bice makers?\b/g, 'Appliance', 6, 'Ice maker'],
    [/\b(?:washing machines?|washers?)\b/g, 'Appliance', 6, 'Washer'],
    [/\bdryers?\b/g, 'Appliance', 6, 'Dryer'],
    [/\b(?:refrigerators?|fridges?|freezers?)\b/g, 'Appliance', 6, 'Refrigerator'],
    [/\b(?:ovens?|ranges?|stoves?|cooktops?)\b/g, 'Appliance', 5, 'Oven / range'],
    [/\bmicrowaves?\b/g, 'Appliance', 6, 'Microwave'],
    [/\bfurnaces?\b/g, 'HVAC', 6, 'Furnace'],
    [/\b(?:central air|central ac|a\/c|air condition(?:er|ing)?|ac unit|ac)\b/g, 'HVAC', 6, 'Central AC'],
    [/\b(?:condensers?|compressors?|air handlers?|mini[ -]?splits?|ductwork|ducts?)\b/g, 'HVAC', 4, 'Central AC'],
    [/\bthermostats?\b/g, 'HVAC', 5, 'Thermostat'],
    [/\bboilers?\b/g, 'HVAC', 4, 'Boiler'],
    [/\btoilets?\b/g, 'Plumbing', 6, 'Toilet'],
    [/\b(?:faucets?|sinks?)\b/g, 'Plumbing', 4, 'Sink / faucet'],
    [/\b(?:sewer|main line|sump pumps?|water softeners?|shower|tub|pipes?|water lines?)\b/g, 'Plumbing', 4, 'Plumbing line'],
    [/\bhvac\b/g, 'HVAC', 5, ''],
    [/\bplumb(?:ing|er)\b/g, 'Plumbing', 4, ''],
    [/\bappliances?\b/g, 'Appliance', 3, ''],
  ];
  const WEAK = [
    [/\b(?:cool(?:ing)?|cold air|warm air|blowing|refrigerant|freon|vents?|heat(?:ing)?|no heat)\b/g, 'HVAC', 1],
    [/\b(?:leak(?:s|ing)?|clog(?:ged)?|drain(?:s|ing)?|water pressure|burst|drip(?:ping)?|backed up)\b/g, 'Plumbing', 1],
    [/\b(?:error code|spin(?:ning)?|tumbl(?:e|ing)|door seal|model (?:no|number))\b/g, 'Appliance', 1],
  ];
  function scoreTrade(text) {
    let t = ' ' + text.toLowerCase() + ' ';
    const score = { HVAC: 0, Plumbing: 0, Appliance: 0 };
    const hits = [];
    for (const [re, trade, w, name] of STRONG) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t))) {
        score[trade] += w;
        if (name) hits.push({ name, trade, index: m.index, w });
      }
      t = t.replace(re, ' ');
    }
    for (const [re, trade, w] of WEAK) {
      const n = (t.match(re) || []).length;
      score[trade] += n * w;
    }
    const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
    const [top, topScore] = ranked[0];
    const margin = topScore - ranked[1][1];
    return { trade: topScore ? top : '', status: topScore >= 5 && margin >= 3 ? 'found' : topScore ? 'inferred' : 'review', score, hits };
  }

  const BRANDS = ['Bosch', 'Whirlpool', 'GE', 'Samsung', 'LG', 'Maytag', 'KitchenAid', 'Frigidaire', 'Kenmore', 'Electrolux', 'Carrier', 'Trane', 'Lennox', 'Rheem', 'Ruud', 'Goodman', 'York', 'Amana', 'A.O. Smith', 'AO Smith', 'Bradford White', 'Navien', 'Rinnai', 'Kohler', 'InSinkErator', 'Moen', 'Delta'];
  function findAge(text) {
    const m = text.match(/(?:approx\.?|approximately|about|around|maybe|roughly|~)?\s*(\d{1,2})\s*(?:\+\s*)?(?:yrs?|years?)(?:\s*old)?\b/i);
    return m ? Number(m[1]) : null;
  }
  function findEquipment(text, trade, hits) {
    const lab = labelled(text, ['Item', 'Appliance', 'Equipment', 'System', 'Unit', 'Product', 'Covered item']);
    const age = findAge(text);
    const pick = hits.filter(h => h.trade === trade).sort((a, b) => b.w - a.w || a.index - b.index)[0];
    const base = pick ? pick.name : '';
    if (lab) return { value: clean(lab), base: base || clean(lab).split(/[,-]/)[0], age, status: 'found' };
    if (!base) return { value: '', base: '', age, status: 'review' };
    const details = [];
    const brand = BRANDS.find(b => new RegExp('\\b' + esc(b) + '\\b', 'i').test(text));
    const size = text.match(/\b(\d{2,3})\s*(?:-\s*)?gal(?:lon)?s?\b/i);
    const fuel = text.match(/\b(gas|electric|propane)\b/i);
    const ton = text.match(/\b(\d(?:\.\d)?)\s*ton\b/i);
    if (size) details.push(size[1] + ' gal');
    if (ton) details.push(ton[1] + ' ton');
    if (fuel && /Water heater|Furnace|Oven|Dryer|Boiler/.test(base)) details.push(fuel[1].toLowerCase());
    if (age) details.push('~' + age + ' yrs old');
    const loc = text.match(/\b(?:in|on)\s+(?:the|my|our)\s+(garage|basement|attic|kitchen|laundry room|utility room|crawl ?space|closet|hall closet|bathroom|master bath|backyard|side yard|roof)\b/i);
    let value = (brand ? brand + ' ' + base.toLowerCase() : base);
    if (details.length) value += ' (' + details.join(', ') + ')';
    if (loc) value += ', ' + loc[1].toLowerCase();
    return { value, base, age, status: 'inferred' };
  }

  // ---------------------------------------------------------------- name
  const NOT_A_NAME = /\b(?:warranty|home|services?|support|dispatch|team|care|protection|plans?|appliance|customer|department|office|summit|inc|llc|co)\b/i;
  function findName(text, from) {
    const lab = labelled(text, ['Contract holder', 'Customer name', 'Customer', 'Homeowner', 'Name', 'Member', 'Policy holder', 'Tenant', 'Contact']);
    if (lab && !/\d{3}/.test(lab)) return { value: titleCaseName(lab.replace(/\s*[,(].*$/, '')), status: 'found' };
    const NAME = "([A-Z][a-z'’-]+(?:\\s+[A-Z]\\.?(?=\\s))?(?:\\s+[A-Z][a-z'’-]+){0,2})";
    const pats = [
      new RegExp("\\b(?:[Mm]y name is|[Tt]his is|I am|I'm)\\s+" + NAME),
      new RegExp("(?:[Tt]hanks|[Tt]hank you|[Rr]egards|[Cc]heers|[Bb]est|[Ss]incerely|[Tt]hx)[\\s,!.]*(?:[-–—~]\\s*)?" + NAME + "\\s*\\.?\\s*$"),
      new RegExp("\\n\\s*[-–—~]\\s*" + NAME + "\\s*$"),
    ];
    for (const re of pats) {
      const m = text.trim().match(re);
      if (m && !NOT_A_NAME.test(m[1]) && /^[A-Z]/.test(m[1])) return { value: m[1].trim(), status: 'found' };
    }
    // Last resort: the sender's email address, e.g. mike.t.renner@ -> Mike Renner
    const local = (from.match(/([a-z0-9._-]+)@/i) || [])[1] || '';
    const parts = local.split(/[._-]+/).filter(p => /^[a-z]{2,}$/i.test(p));
    if (parts.length >= 2 && !NOT_A_NAME.test(parts.join(' '))) {
      return { value: titleCase(parts[0] + ' ' + parts[parts.length - 1]), status: 'inferred' };
    }
    return { value: '', status: 'review' };
  }
  const titleCaseName = s => (s === s.toLowerCase() || s === s.toUpperCase() ? titleCase(s) : s).trim();

  // ---------------------------------------------------------------- problem summary
  const PROBLEM_WORDS = /\b(?:leak\w*|not|won'?t|wont|doesn'?t|isn'?t|broken|stopped|noise|noisy|grinding|squeal\w*|smell\w*|error|no heat|no hot water|clog\w*|drip\w*|flood\w*|running|tripp\w*|sparking|warm|cold|frozen|iced)\b/i;
  function tidy(s) {
    return cap(clean(s)
      .replace(/^(?:hi|hello|hey)[^,.!]*[,.!]\s*/i, '')
      .replace(/^(?:so|and|but|also|um|well)\s+/i, '')
      .replace(/^(?:our|my|the)\s+/i, '')
      .replace(/\btheres\b/gi, "there's").replace(/\bits\b(?= \w+ing| a | an | the | like)/gi, "it's")
      .replace(/\bim\b/gi, "I'm").replace(/\bi\b/g, 'I').replace(/\bdont\b/gi, "don't").replace(/\bwont\b/gi, "won't").replace(/\bcant\b/gi, "can't")
      .replace(/\blike\s+(?=(?:a|an|\d)\b)/gi, '')
      .replace(/\bpretty bad(?:ly)?\b/gi, 'badly')
      .replace(/[!?]{2,}/g, '!')
      .replace(/\s+([,.!?])/g, '$1')
      .replace(/[,;:\s]+$/, ''));
  }
  const endSentence = s => (s && !/[.!?]$/.test(s) ? s + '.' : s);
  function findProblem(text, base) {
    const lab = labelled(text, ['Customer reports', 'Reported issue', 'Problem', 'Issue', 'Complaint', 'Description', 'Symptoms', 'Reason for call', 'Details', 'Customer states']);
    if (lab) {
      const sentences = lab.split(/(?<=[.!?])\s+/);
      let s = sentences[0].replace(/[.!?]+$/, '');
      if (sentences[1] && sentences[1].length < 40 && /\b(?:start|since|yesterday|today|days?|weeks?|morning|night|ago)\b/i.test(sentences[1])) {
        s += '; ' + sentences[1].replace(/[.!?]+$/, '').replace(/^[A-Z]/, c => c.toLowerCase());
      }
      s = tidy(s);
      if (base && /^(?:not|won'?t|no|is|keeps|makes|making|leaking|stopped|leaks|runs|running|shuts)\b/i.test(s)) s = base + ' ' + s.charAt(0).toLowerCase() + s.slice(1);
      return { value: endSentence(s), status: 'found' };
    }
    const body = text.replace(/^.*(?:forwarded message|^from:|^to:|^sent:).*$/gim, '');
    const sentences = body.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 12);
    let best = '', bestScore = 0;
    for (const s of sentences) {
      let sc = 0;
      if (PROBLEM_WORDS.test(s)) sc += 2;
      if (base && s.toLowerCase().includes(base.toLowerCase().split(' ')[0])) sc += 2;
      if (/\b(?:neighbor|thanks|call me|cell|phone|address|i'?m at)\b/i.test(s)) sc -= 2;
      if (sc > bestScore) { best = s; bestScore = sc; }
    }
    if (!best) return { value: '', status: 'review' };
    let s = best.split(/\.\s+(?=can|could|please|im|i'm|my|call|we)/i)[0];
    return { value: endSentence(tidy(s.replace(/[.!?]+$/, ''))), status: 'inferred' };
  }

  // ---------------------------------------------------------------- urgency & flags
  const VULNERABLE = /\b(elderly|senior|aged|\d{2}[- ]year[- ]old (?:mother|father|mom|dad|resident)|infant|baby|newborn|pregnant|disabled|wheelchair|medical|oxygen|dialysis|hospice|immunocompromised)\b/i;
  const EMERGENCY_CUES = [
    [/water everywhere/i, 'water everywhere'],
    [/\binch(?:es)? of water\b/i, 'standing water on the floor'],
    [/\bflood(?:ed|ing)?\b/i, 'flooding'],
    [/\bburst\b/i, 'burst pipe'],
    [/\b(?:smell(?:s|ing)? (?:of |like )?gas|gas (?:smell|leak|odor))\b/i, 'possible gas leak'],
    [/\b(?:carbon monoxide|co (?:alarm|detector))\b/i, 'CO alarm'],
    [/\b(?:sparking|sparks|smoke|smoking|burning smell)\b/i, 'sparks / smoke'],
    [/\b(?:sewage|sewer backup|backed up into)\b/i, 'sewage backup'],
  ];
  const HIGH_CUES = [
    [/\b(?:today|asap|urgent|right away|emergency|immediately)\b/i, 'asked for same-day'],
    [/\bleak(?:s|ing)?\b/i, 'active leak'],
    [/\bno (?:heat|hot water|ac|a\/c|air)\b|\bnot heating\b/i, 'no heat / hot water'],
    [/\b(?:will not|won'?t|not|isn'?t) cool(?:ing)?\b|\bblowing warm\b/i, 'no cooling'],
    [/!{2,}/, 'customer sounds stressed'],
  ];
  function findUrgency(text) {
    const reasons = [];
    let level = 'Normal';
    for (const [re, why] of EMERGENCY_CUES) if (re.test(text)) reasons.push(why);
    if (reasons.length) level = 'Emergency';
    const high = [];
    for (const [re, why] of HIGH_CUES) if (re.test(text)) high.push(why);
    const v = text.match(VULNERABLE);
    if (v) high.unshift(v[1].toLowerCase() + ' occupant');
    const temp = text.match(/\b(?:below|above|over|at|is)\s+(\d{2,3})\b(?!\s*(?:gal|yrs?|years?|min))/i);
    if (temp && Number(temp[1]) >= 80 && Number(temp[1]) <= 120 && /cool|hot|temp|degrees/i.test(text)) high.push('indoor temp ' + temp[1] + '°F');
    if (level === 'Normal' && high.length) level = 'High';
    return { level, reasons: reasons.concat(high).slice(0, 4), status: 'inferred' };
  }

  function findFlags(ctx) {
    const { text, subject, vendor, claim, urgency, age, base, phones, address, name, existing } = ctx;
    const flags = [];
    const add = (kind, msg) => flags.push({ kind, msg });
    if (vendor.claimPrefix && !claim) {
      add('warn', `No claim number yet: follow up with ${vendor.short} before dispatch` + (/to follow/i.test(text) ? ' (they said "to follow")' : ''));
    }
    const fee = text.match(/(?:service|deductible|trade call|copay)\s*fee\s*(?:collected|paid)\s*:?\s*\$?\s*(\d+(?:\.\d{2})?)/i) || text.match(/collected\s*(?:a\s*)?\$?\s*(\d+(?:\.\d{2})?)\s*(?:service|deductible)/i);
    if (fee) add('good', `Service fee already collected: $${Number(fee[1]).toFixed(0)}. Do not collect on site.`);
    const v = text.match(VULNERABLE);
    if (v) add('bad', `Vulnerable occupant mentioned (${v[1].toLowerCase()}): prioritize and call ahead`);
    const shut = /\b(?:turn(?:ed)?|shut|close[d]?)\s+(?:off\s+)?(?:the\s+|my\s+|our\s+)?(?:main\s+)?(?:\w+\s+)?(?:valve|water|gas|breaker|power|main)\b(?:\s+\w+){0,3}\s*(?:off)?/i;
    if (shut.test(text) && /\boff\b/i.test(text.match(shut)[0] + ' ' + text.slice(text.search(shut), text.search(shut) + 50))) {
      const what = /gas/i.test(text.match(shut)[0]) ? 'gas' : /breaker|power/i.test(text.match(shut)[0]) ? 'power' : 'water/gas';
      add('warn', `Customer may have shut off ${what}: confirm before arrival` + (/\?\?|i think|not sure/i.test(text) ? ' (they weren\'t sure)' : ''));
    }
    if (urgency.level === 'Emergency') add('bad', 'Emergency: call the customer within 1 hour and confirm the leak/hazard is contained');
    const window_ = text.match(/\b(?:come|out|here|available|schedule)\b[^.!?\n]{0,25}?\b((?:today|tomorrow|this|next|any ?time|after|before|between|mon|tue|wed|thu|fri|sat|sun)[^.!?\n]{0,40})/i);
    if (window_) add('info', `Customer asked for: "${clean(window_[1])}"`);
    if (/\b(?:neighbor|friend|coworker|referred|recommended)\b/i.test(text)) add('info', 'Referral: ask who sent them and thank the referrer');
    if (age && age >= 10 && /Water heater|Central AC|Furnace|Heat pump|Refrigerator|Washer|Dryer|Dishwasher/.test(base)) add('info', `${base} is ~${age} yrs old: bring a replacement quote option`);
    const code = text.match(/\b(?:error|fault)\s*(?:code)?\s*:?\s*([A-Z]?\d{1,2}[A-Z]?|[A-Z]{1,2}\d?)\b/);
    if (code) add('info', `Error code ${code[1]} reported: check service manual before the visit`);
    if (/\b(?:update|close) (?:the )?portal\b/i.test(text)) add('info', `${vendor.short} portal update required after first contact`);
    if (/^\s*(?:fw|fwd)\s*:/i.test(subject) || /forwarded message/i.test(text)) add('info', 'Forwarded email: details came second-hand, verify with the customer');
    if (!phones.length) add('bad', 'No phone number found: reply to sender for a callback number');
    if (!address) add('bad', 'No service address found');
    if (!name) add('warn', 'Customer name not found');
    if (existing) add('good', `Existing customer on file: ${existing.name} (${existing.id})`);
    return flags;
  }

  // ---------------------------------------------------------------- main parse
  function parse(raw, S, now) {
    const t0 = Date.now();
    now = now ? new Date(now) : new Date();
    const { from, subject, body } = splitHeaders(String(raw || ''));
    const text = (subject ? subject + '\n' : '') + body;
    const companyPhones = [S.company.phone].concat(S.techs.map(t => t.phone));

    const claimRes = findClaim(text, S.vendors);
    const vendorRes = findVendor(from, text, claimRes.vendor, S.vendors);
    const vendor = vendorRes.vendor;
    const tradeRes = scoreTrade(text);
    const equip = findEquipment(body, tradeRes.trade, tradeRes.hits);
    const nameRes = findName(body, from);
    const phones = findPhones(body, companyPhones);
    const addr = findAddress(body);
    const problem = findProblem(body, equip.base);
    const urgency = findUrgency(text);

    const within = text.match(/within\s+(\d{1,3})\s*(?:hours|hrs?)\b/i);
    let hours = within ? Number(within[1]) : vendor.firstCallHours;
    if (urgency.level === 'Emergency') hours = Math.min(hours, 1);

    const existing = S.customers.find(c =>
      (phones.some(p => p.number === c.phone)) ||
      (addr.street && c.address.toLowerCase() === addr.street.toLowerCase()));

    const flags = findFlags({
      text, subject, vendor, claim: claimRes.claim, urgency, age: equip.age, base: equip.base,
      phones, address: addr.street, name: nameRes.value, existing,
    });

    const phoneText = phones.map((p, i) => p.number + (p.kind && i > 0 ? ' (' + p.kind + ')' : '')).join(', ');
    return {
      fields: {
        customer: field(nameRes.value, nameRes.status),
        phone: field(phoneText, 'found'),
        address: field(addr.street, addr.status),
        zip: field(addr.zip, 'found'),
        vendor: { value: vendor.id, status: vendorRes.status },
        claim: field(claimRes.claim, 'found', vendor.claimPrefix ? '' : 'not needed'),
        trade: field(tradeRes.trade, tradeRes.status),
        equipment: field(equip.value, equip.status),
        problem: field(problem.value, problem.status),
        urgency: { value: urgency.level, status: 'inferred' },
      },
      urgencyReasons: urgency.reasons,
      firstCallHours: hours,
      deadline: new Date(now.getTime() + hours * 3600000).toISOString(),
      receivedAt: now.toISOString(),
      flags,
      from, subject,
      existingCustomerId: existing ? existing.id : null,
      equipmentBase: equip.base,
      engine: 'builtin',
      ms: Math.max(1, Date.now() - t0),
      debug: { tradeScore: tradeRes.score },
    };
  }

  // ---------------------------------------------------------------- tech suggestion
  function suggestTech(trade, S, extraJobs) {
    const today = new Date(S.today);
    const end = new Date(today.getTime() + 2 * 86400000);
    const open = ['scheduled', 'en_route', 'in_progress', 'new'];
    const jobs = S.jobs.concat(extraJobs || []);
    const load = S.techs.filter(t => t.trade === trade).map(t => {
      const mine = jobs.filter(j => j.techId === t.id && j.scheduledStart && open.includes(j.status) &&
        new Date(j.scheduledStart) >= today && new Date(j.scheduledStart) < end);
      return { tech: t, jobs: mine.length, hours: mine.reduce((s, j) => s + (j.durationHrs || 0), 0) };
    }).sort((a, b) => a.jobs - b.jobs || a.hours - b.hours);
    return load;
  }

  // ---------------------------------------------------------------- first-contact text
  const TRADE_PERSON = { HVAC: 'HVAC tech', Plumbing: 'plumber', Appliance: 'appliance tech' };
  function nextBusinessDay(now) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    while (d.getDay() === 0) d.setDate(d.getDate() + 1);
    const diff = Math.round((d - new Date(new Date(now).setHours(0, 0, 0, 0))) / 86400000);
    return diff <= 1 ? 'tomorrow' : d.toLocaleDateString('en-US', { weekday: 'long' });
  }
  function draftText(t, S, now) {
    const first = (t.customer || '').split(/\s+/)[0] || 'there';
    const v = S.vendors.find(x => x.id === t.vendor) || {};
    const tech = S.techs.find(x => x.id === t.techId);
    const what = (t.equipmentBase || t.trade || 'service').toLowerCase().replace(/^central ac$/, 'AC');
    const who = tech ? `${tech.name.split(' ')[0]}, our ${TRADE_PERSON[tech.trade] || 'technician'},` : 'a technician';
    const day = nextBusinessDay(now || new Date());
    let msg = `Hi ${first}, this is Summit Home Services. `;
    if (v.claimPrefix) msg += `${v.short} sent us your ${what} repair request${t.claim ? ' (claim ' + t.claim + ')' : ''}. `;
    else msg += `We got your message about the ${what}. `;
    if (t.urgency === 'Emergency') {
      msg += `We're treating this as an emergency and can have ${who} there today. Will someone be home in the next 2 hours?`;
    } else if (t.urgency === 'High') {
      msg += `We can get ${who} out as early as today. Which works better: morning (8-12) or afternoon (12-4)?`;
    } else {
      msg += `We'd like to get ${who} out to you. Does ${day} morning (8-12) or afternoon (12-4) work better?`;
    }
    msg += ` Reply here or call ${S.company.phone}.`;
    return msg.replace(/\s{2,}/g, ' ');
  }

  // ---------------------------------------------------------------- Claude engine
  const CLAUDE_MODEL = 'claude-sonnet-5';
  function claudePrompt(raw, S) {
    const vendors = S.vendors.map(v => `- ${v.name} (id ${v.id}${v.claimPrefix ? ', claim numbers start with "' + v.claimPrefix + '"' : ', no claim number'})`).join('\n');
    return {
      system: `You are the intake assistant for ${S.company.name}, a home service company (HVAC, plumbing, appliance repair). You read incoming work-order emails and extract a clean ticket. Reply with ONLY a JSON object, no prose and no code fences.`,
      user: `Known vendors that send work orders:\n${vendors}\n\nReturn JSON with exactly these keys:\n{\n  "customerName": string|null,\n  "phones": string[] (format "(555) 013-5521"; customer numbers only),\n  "address": string|null (street line only, no ZIP),\n  "zip": string|null,\n  "claimNumber": string|null,\n  "vendorId": "V0"|"V1"|"V2"|"V3" (V0 = direct customer),\n  "trade": "HVAC"|"Plumbing"|"Appliance",\n  "equipment": string|null (short, e.g. "Water heater (50 gal, gas, ~12 yrs old), garage"),\n  "equipmentBase": string (one or two words, e.g. "Water heater"),\n  "problemSummary": string (one clear sentence for the technician),\n  "urgency": "Emergency"|"High"|"Normal",\n  "urgencyReasons": string[] (short),\n  "flags": string[] (things the office must act on: missing claim number, vulnerable occupant, utilities shut off, fees already collected, requested time window, etc.)\n}\nUse null when the email does not contain a value. Do not invent data.\n\nEMAIL:\n"""\n${raw}\n"""`,
    };
  }
  function parseClaudeJson(text) {
    const m = String(text).replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Claude did not return JSON');
    return JSON.parse(m[0]);
  }
  // Map Claude's JSON onto the same ticket shape the built-in parser produces.
  function fromClaude(j, raw, S, now, ms) {
    const base = parse(raw, S, now); // for deadline rules, existing-customer check and fallbacks
    const f = base.fields;
    const st = v => (v ? 'found' : 'review');
    const vendor = S.vendors.find(v => v.id === j.vendorId) || S.vendors.find(v => v.id === f.vendor.value);
    const phones = (Array.isArray(j.phones) ? j.phones : []).map(normalizePhone).filter(Boolean).join(', ');
    const urgency = ['Emergency', 'High', 'Normal'].includes(j.urgency) ? j.urgency : f.urgency.value;
    let hours = vendor.firstCallHours;
    const within = raw.match(/within\s+(\d{1,3})\s*(?:hours|hrs?)\b/i);
    if (within) hours = Number(within[1]);
    if (urgency === 'Emergency') hours = Math.min(hours, 1);
    const flags = (Array.isArray(j.flags) ? j.flags : []).map(msg => ({
      kind: /vulnerable|elderly|emergency|no phone|missing address/i.test(msg) ? 'bad' : /collected|existing/i.test(msg) ? 'good' : /claim|shut|confirm|follow/i.test(msg) ? 'warn' : 'info',
      msg: String(msg),
    }));
    if (vendor.claimPrefix && !j.claimNumber && !flags.some(x => /claim/i.test(x.msg))) flags.unshift({ kind: 'warn', msg: `No claim number yet: follow up with ${vendor.short}` });
    return Object.assign({}, base, {
      fields: {
        customer: { value: j.customerName || '', status: st(j.customerName) },
        phone: { value: phones, status: st(phones) },
        address: { value: j.address || '', status: st(j.address) },
        zip: { value: j.zip || '', status: st(j.zip) },
        vendor: { value: vendor.id, status: 'found' },
        claim: { value: j.claimNumber || '', status: st(j.claimNumber), note: vendor.claimPrefix ? '' : 'not needed' },
        trade: { value: j.trade || f.trade.value, status: st(j.trade) },
        equipment: { value: j.equipment || '', status: st(j.equipment) },
        problem: { value: j.problemSummary || '', status: st(j.problemSummary) },
        urgency: { value: urgency, status: 'found' },
      },
      equipmentBase: j.equipmentBase || '',
      urgencyReasons: Array.isArray(j.urgencyReasons) ? j.urgencyReasons.slice(0, 4) : base.urgencyReasons,
      firstCallHours: hours,
      deadline: new Date(new Date(base.receivedAt).getTime() + hours * 3600000).toISOString(),
      flags: flags.concat(base.flags.filter(x => /^Existing customer/.test(x.msg))),
      engine: 'claude',
      ms,
    });
  }
  async function extractWithClaude(raw, key, S, now) {
    const t0 = Date.now();
    const p = claudePrompt(raw, S);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1024, system: p.system, messages: [{ role: 'user', content: p.user }] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status));
    const txt = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    return fromClaude(parseClaudeJson(txt), raw, S, now, Date.now() - t0);
  }

  const api = { parse, suggestTech, draftText, normalizePhone, extractWithClaude, fromClaude, parseClaudeJson, claudePrompt, CLAUDE_MODEL, splitHeaders };
  root.Intake = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);


// ===================================================================== UI
(function () {
  'use strict';
  if (typeof document === 'undefined' || !window.SUMMIT) return;
  const S = window.SUMMIT;
  const I = window.Intake;
  const $ = (sel, el = document) => el.querySelector(sel);
  const h = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const QKEY = 'summit-intake-queue-v1';
  const KKEY = 'summit-intake-claude-key';

  const store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked: queue lives in memory */ } },
  };
  const session = {
    get(k) { try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set(k, v) { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  let queue = store.get(QKEY, []);
  if (!Array.isArray(queue)) queue = [];
  let ticket = null;     // current draft ticket (flat values)
  let meta = null;       // parse result (statuses, flags, timings)
  let memKey = session.get(KKEY);

  const els = {
    email: $('#email'), create: $('#create'), clear: $('#clear-email'), samples: $('#samples'),
    out: $('#ticket'), queue: $('#queue'), qcount: $('#qcount'), qclear: $('#qclear'),
    useClaude: $('#use-claude'), key: $('#api-key'), remember: $('#remember-key'), keyStatus: $('#key-status'),
    status: $('#status'),
  };

  // ------------------------------------------------------------ samples
  els.samples.innerHTML = S.sampleEmails.map((e, i) => {
    const v = S.vendors.find(x => x.claimPrefix && e.from.toLowerCase().includes(x.short.toLowerCase()));
    const who = v ? v.short : e.from.split('@')[0].split(/[._]/)[0];
    return `<button type="button" class="mail" data-i="${i}" aria-label="Load sample: ${h(e.label)}">
      <span class="mail-av" aria-hidden="true">${h(who.charAt(0).toUpperCase())}</span>
      <span class="mail-txt"><span class="mail-from">${h(v ? v.name : e.from)}</span>
      <span class="mail-subj">${h(e.subject)}</span>
      <span class="mail-tag">${h(e.label)}</span></span></button>`;
  }).join('');
  const emailText = e => `From: ${e.from}\nSubject: ${e.subject}\n\n${e.body}`;
  function loadSample(i) {
    els.email.value = emailText(S.sampleEmails[i]);
    [...els.samples.children].forEach((b, j) => b.classList.toggle('active', j === i));
  }
  els.samples.addEventListener('click', e => {
    const b = e.target.closest('.mail');
    if (!b) return;
    loadSample(Number(b.dataset.i));
    run();
  });
  els.clear.addEventListener('click', () => {
    els.email.value = '';
    [...els.samples.children].forEach(b => b.classList.remove('active'));
    els.email.focus();
  });

  // ------------------------------------------------------------ Claude key
  if (memKey) { els.key.value = memKey; els.remember.checked = true; }
  function syncKey() {
    memKey = els.key.value.trim();
    session.set(KKEY, els.remember.checked ? memKey : '');
    els.keyStatus.textContent = memKey ? (els.useClaude.checked ? 'Key set. Next ticket will use Claude.' : 'Key set. Tick "Use Claude" to switch engines.') : 'No key entered. The built-in parser is used.';
  }
  els.key.addEventListener('input', syncKey);
  els.remember.addEventListener('change', syncKey);
  els.useClaude.addEventListener('change', syncKey);
  syncKey();

  // ------------------------------------------------------------ run extraction
  function setStatus(msg, kind) {
    els.status.textContent = msg || '';
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }
  async function run() {
    const raw = els.email.value.trim();
    if (!raw) { setStatus('Paste an email first, or pick one from the sample inbox.', 'warn'); els.email.focus(); return; }
    els.create.disabled = true;
    els.out.classList.add('loading');
    let result, note = '';
    if (els.useClaude.checked && memKey) {
      setStatus('Asking Claude to read the email…');
      try {
        result = await I.extractWithClaude(raw, memKey, S);
      } catch (err) {
        result = I.parse(raw, S);
        note = `Claude request failed (${err.message}). Used the built-in parser instead.`;
      }
    } else {
      await new Promise(r => setTimeout(r, 260)); // brief beat so the change is visible
      result = I.parse(raw, S);
      if (els.useClaude.checked && !memKey) note = 'No API key entered, so the built-in parser was used.';
    }
    load(result);
    els.create.disabled = false;
    els.out.classList.remove('loading');
    const f = Object.values(result.fields);
    const found = f.filter(x => x.status !== 'review').length;
    setStatus(note || `Ticket drafted: ${found} of ${f.length} fields filled in ${result.engine === 'claude' ? (result.ms / 1000).toFixed(1) + ' s by Claude' : result.ms + ' ms'}. Review the highlighted fields, then add it to the queue.`, note ? 'warn' : 'good');
  }
  els.create.addEventListener('click', run);
  els.email.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(); });

  function nextTicketNo() {
    const nums = S.jobs.map(j => j.id).concat(queue.map(q => q.id)).map(id => Number(String(id).replace(/\D/g, '')) || 0);
    return 'SH-' + (Math.max(...nums) + 1);
  }

  function load(r) {
    meta = r;
    const f = r.fields;
    const v = {};
    Object.keys(f).forEach(k => (v[k] = f[k].value));
    v.equipmentBase = r.equipmentBase || (v.equipment.match(/water heater|dishwasher|ice maker|heat pump|garbage disposal|central ac|washer|dryer|refrigerator|oven|furnace|thermostat|toilet|microwave|boiler/i) || [''])[0];
    v.equipmentBase = v.equipmentBase ? v.equipmentBase.charAt(0).toUpperCase() + v.equipmentBase.slice(1) : '';
    const best = I.suggestTech(v.trade, S, queueJobs())[0];
    v.techId = best ? best.tech.id : '';
    v.flags = r.flags.slice();
    v.edited = {};
    ticket = v;
    ticket.sms = I.draftText(ticket, S);
    render();
  }

  // Queue items count toward tech load once they are assigned.
  const queueJobs = () => queue.filter(q => q.techId).map(q => ({ techId: q.techId, status: 'scheduled', scheduledStart: S.today, durationHrs: 2 }));

  // ------------------------------------------------------------ render ticket
  const STATUS_CHIP = {
    found: '<span class="chip good" title="Read directly from the email">found</span>',
    inferred: '<span class="chip info" title="Worked out from clues in the email. Worth a glance.">inferred</span>',
    review: '<span class="chip warn" title="Not in the email. Fill in or follow up.">needs review</span>',
    edited: '<span class="chip" title="Changed by you">edited</span>',
    na: '<span class="chip" title="Direct customers have no claim number">not needed</span>',
  };
  const claimNA = () => !ticket.claim && !(S.vendors.find(v => v.id === ticket.vendor) || {}).claimPrefix;
  const chipFor = k => (ticket.edited[k] && !(k === 'claim' && claimNA()) ? STATUS_CHIP.edited : k === 'claim' && claimNA() ? STATUS_CHIP.na : STATUS_CHIP[(meta.fields[k] || {}).status || 'inferred']);
  const URG_CLASS = { Emergency: 'bad', High: 'warn', Normal: 'good' };

  function fmtDeadline(iso, now = Date.now()) {
    const ms = new Date(iso) - now;
    const abs = Math.abs(ms);
    const hrs = Math.floor(abs / 3600000), mins = Math.floor((abs % 3600000) / 60000);
    const span = hrs ? `${hrs}h ${String(mins).padStart(2, '0')}m` : `${mins}m`;
    return ms >= 0 ? { text: span + ' left', cls: ms < 3600000 ? 'bad' : ms < 4 * 3600000 ? 'warn' : 'good' } : { text: span + ' overdue', cls: 'bad' };
  }
  const clock = iso => new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

  function deadlineFor(t) {
    const v = S.vendors.find(x => x.id === t.vendor);
    let hours = v.firstCallHours;
    const within = (els.email.value.match(/within\s+(\d{1,3})\s*(?:hours|hrs?)\b/i) || [])[1];
    if (within && v.claimPrefix && v.id === meta.fields.vendor.value) hours = Number(within);
    const baseHours = hours;
    if (t.urgency === 'Emergency') hours = Math.min(hours, 1);
    return { hours, baseHours, iso: new Date(new Date(meta.receivedAt).getTime() + hours * 3600000).toISOString(), vendor: v };
  }

  function input(k, label, opts = {}) {
    const id = 'f-' + k;
    const val = ticket[k] || '';
    const ph = opts.placeholder || (meta.fields[k] && meta.fields[k].note) || 'Not found in email';
    const ctl = opts.multiline
      ? `<textarea id="${id}" data-k="${k}" rows="1" class="grow" placeholder="${h(ph)}">${h(val)}</textarea>`
      : `<input id="${id}" data-k="${k}" value="${h(val)}" placeholder="${h(ph)}" ${opts.mono ? 'class="mono"' : ''} autocomplete="off">`;
    return `<div class="fld ${opts.wide ? 'wide' : ''} ${!val && meta.fields[k].status === 'review' && !(k === 'claim' && claimNA()) ? 'empty' : ''}">
      <div class="fld-head"><label for="${id}">${label}</label>${chipFor(k)}</div>${ctl}</div>`;
  }
  function select(k, label, options) {
    const id = 'f-' + k;
    return `<div class="fld"><div class="fld-head"><label for="${id}">${label}</label>${chipFor(k)}</div>
      <select id="${id}" data-k="${k}">${options.map(([v, t]) => `<option value="${h(v)}" ${v === ticket[k] ? 'selected' : ''}>${h(t)}</option>`).join('')}</select></div>`;
  }

  function render() {
    if (!ticket) return;
    const dl = deadlineFor(ticket);
    const d = fmtDeadline(dl.iso);
    const load = I.suggestTech(ticket.trade, S, queueJobs());
    const best = load[0];
    const techOpts = S.techs.map(t => {
      const l = load.find(x => x.tech.id === t.id);
      return [t.id, l ? `${t.name} · ${l.jobs} job${l.jobs === 1 ? '' : 's'}` : `${t.name} (${t.trade})`];
    });
    const engine = meta.engine === 'claude'
      ? `<span class="engine claude">Claude · ${h(I.CLAUDE_MODEL)}</span>`
      : `<span class="engine">Built-in parser · offline</span>`;
    const urgCls = URG_CLASS[ticket.urgency] || '';
    const flags = ticket.flags;
    const smsLen = ticket.sms.length;

    els.out.innerHTML = `
      <div class="t-head">
        <div>
          <div class="t-no mono">${h(nextTicketNo())} <span class="muted">· draft</span></div>
          <h2 class="t-title">${h(ticket.customer || 'Unknown customer')}</h2>
          <div class="t-sub muted">${h([ticket.equipmentBase || ticket.trade, S.vendors.find(v => v.id === ticket.vendor).name].filter(Boolean).join(' · '))}</div>
        </div>
        <div class="t-badges">
          <span class="urg ${urgCls}">${h(ticket.urgency)}</span>
          ${engine}
        </div>
      </div>

      <div class="sla ${d.cls}">
        <div><span class="sla-k">First call due</span><span class="sla-v">${h(clock(dl.iso))}</span></div>
        <div><span class="sla-k">Time left</span><span class="sla-v mono" data-countdown="${h(dl.iso)}">${h(d.text)}</span></div>
        <div class="sla-why muted">${h(dl.vendor.short)} rule: ${dl.baseHours} hrs${ticket.urgency === 'Emergency' ? ' · emergency: 1 hr' : ''}</div>
      </div>

      ${flags.length ? `<div class="flags" role="list" aria-label="Things to act on">
        <div class="flags-h">Heads up <span class="chip">${flags.length}</span></div>
        ${flags.map((f, i) => `<div class="flag ${f.kind}" role="listitem"><span class="flag-dot" aria-hidden="true"></span><span>${h(f.msg)}</span>
          <button type="button" class="x" data-flag="${i}" aria-label="Dismiss: ${h(f.msg)}">×</button></div>`).join('')}
      </div>` : ''}

      <div class="fields">
        ${input('customer', 'Customer')}
        ${input('phone', 'Phone', { mono: true })}
        ${input('address', 'Service address', { wide: false })}
        ${input('zip', 'ZIP', { mono: true })}
        ${select('vendor', 'Source / vendor', S.vendors.map(v => [v.id, v.name]))}
        ${input('claim', 'Claim #', { mono: true, placeholder: S.vendors.find(v => v.id === ticket.vendor).claimPrefix ? 'Waiting on ' + S.vendors.find(v => v.id === ticket.vendor).short : 'Not needed (direct)' })}
        ${select('trade', 'Trade', [['HVAC', 'HVAC'], ['Plumbing', 'Plumbing'], ['Appliance', 'Appliance']].concat(ticket.trade ? [] : [['', 'Choose…']]))}
        ${select('urgency', 'Urgency', [['Emergency', 'Emergency'], ['High', 'High'], ['Normal', 'Normal']])}
        ${input('equipment', 'Equipment / system', { wide: true, multiline: true })}
        ${input('problem', 'Problem summary', { wide: true, multiline: true })}
      </div>
      ${meta.urgencyReasons.length ? `<p class="why muted"><b>Why ${h(meta.fields.urgency.value)}:</b> ${h(meta.urgencyReasons.join(', '))}</p>` : ''}

      <div class="tech">
        <div class="tech-av" style="--c:${h((S.techs.find(t => t.id === ticket.techId) || {}).color || '#888')}" aria-hidden="true">${h((S.techs.find(t => t.id === ticket.techId) || {}).initials || '?')}</div>
        <div class="tech-body">
          <label for="f-techId">Suggested technician</label>
          <select id="f-techId" data-k="techId">${techOpts.map(([v, t]) => `<option value="${v}" ${v === ticket.techId ? 'selected' : ''}>${h(t)}</option>`).join('')}</select>
          <p class="muted small">${best ? `${h(best.tech.name.split(' ')[0])} is the ${h(ticket.trade)} tech with the lightest load: ${best.jobs} job${best.jobs === 1 ? '' : 's'} (${best.hours} hrs) booked today and tomorrow.` : 'Pick a trade to get a suggestion.'}</p>
        </div>
      </div>

      <div class="sms">
        <div class="sms-head">
          <label for="f-sms">First-contact text to customer</label>
          <span class="muted small mono" id="sms-count">${smsLen} chars · ${Math.ceil(smsLen / 160)} SMS</span>
        </div>
        <div class="bubble-wrap">
          <textarea id="f-sms" data-k="sms" rows="3" class="bubble grow">${h(ticket.sms)}</textarea>
        </div>
        <div class="row sms-actions">
          <button type="button" class="btn ghost small" id="copy-sms">Copy text</button>
          <button type="button" class="btn ghost small" id="redraft">Redraft</button>
          <span class="muted small" id="copy-msg" aria-live="polite"></span>
        </div>
      </div>

      <div class="t-actions">
        <button type="button" class="btn" id="add-queue">Add to queue</button>
        <span class="muted small">Saves as ${h(nextTicketNo())} and starts the first-call clock.</span>
      </div>`;
    els.out.querySelectorAll('textarea.grow').forEach(grow);
  }
  function grow(ta) { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight + 2) + 'px'; }
  window.addEventListener('resize', () => els.out.querySelectorAll('textarea.grow').forEach(grow));

  // Inline edits. Derived parts (deadline, tech, text) refresh when key fields change.
  els.out.addEventListener('input', e => {
    const k = e.target.dataset.k;
    if (!k || !ticket) return;
    ticket[k] = e.target.value;
    if (e.target.classList.contains('grow')) grow(e.target);
    if (k === 'sms') { const n = ticket.sms.length; $('#sms-count').textContent = `${n} chars · ${Math.ceil(n / 160)} SMS`; return; }
    ticket.edited[k] = true;
    const chip = e.target.closest('.fld') && e.target.closest('.fld').querySelector('.chip');
    if (chip) chip.outerHTML = STATUS_CHIP.edited;
    e.target.closest('.fld') && e.target.closest('.fld').classList.remove('empty');
    if (k === 'customer' || k === 'claim') { ticket.sms = I.draftText(ticket, S); $('#f-sms').value = ticket.sms; grow($('#f-sms')); }
  });
  els.out.addEventListener('change', e => {
    const k = e.target.dataset.k;
    if (!k || !ticket || e.target.tagName !== 'SELECT') return;
    if (k === 'trade') {
      const best = I.suggestTech(ticket.trade, S, queueJobs())[0];
      if (best) ticket.techId = best.tech.id;
    }
    if (k === 'vendor') {
      const v = S.vendors.find(x => x.id === ticket.vendor);
      ticket.flags = ticket.flags.filter(f => !/^No claim number/.test(f.msg));
      if (v.claimPrefix && !ticket.claim) ticket.flags.unshift({ kind: 'warn', msg: `No claim number yet: follow up with ${v.short} before dispatch` });
    }
    if (k !== 'techId') ticket.edited[k] = true;
    ticket.sms = I.draftText(ticket, S);
    const focusId = e.target.id;
    render();
    const el = document.getElementById(focusId);
    if (el) el.focus();
  });
  els.out.addEventListener('click', e => {
    const x = e.target.closest('[data-flag]');
    if (x) { ticket.flags.splice(Number(x.dataset.flag), 1); render(); return; }
    if (e.target.id === 'copy-sms') copy(ticket.sms);
    if (e.target.id === 'redraft') { ticket.sms = I.draftText(ticket, S); $('#f-sms').value = ticket.sms; $('#f-sms').dispatchEvent(new Event('input', { bubbles: true })); }
    if (e.target.id === 'add-queue') addToQueue();
  });

  async function copy(text) {
    const msg = $('#copy-msg');
    try {
      await navigator.clipboard.writeText(text);
      msg.textContent = 'Copied.';
    } catch (err) {
      const ta = $('#f-sms'); ta.focus(); ta.select();
      try { document.execCommand('copy'); msg.textContent = 'Copied.'; } catch (e2) { msg.textContent = 'Press Ctrl/Cmd+C to copy.'; }
    }
    setTimeout(() => { msg.textContent = ''; }, 2200);
  }

  // ------------------------------------------------------------ queue
  function addToQueue() {
    const dl = deadlineFor(ticket);
    const item = {
      id: nextTicketNo(), customer: ticket.customer, phone: ticket.phone, address: ticket.address, zip: ticket.zip,
      vendor: ticket.vendor, claim: ticket.claim, trade: ticket.trade, equipment: ticket.equipment, problem: ticket.problem,
      urgency: ticket.urgency, techId: ticket.techId, sms: ticket.sms, flags: ticket.flags.map(f => f.msg),
      deadline: dl.iso, createdAt: new Date().toISOString(), calledAt: null, engine: meta.engine,
    };
    queue.unshift(item);
    store.set(QKEY, queue);
    renderQueue();
    setStatus(`${item.id} added to the queue for ${(S.techs.find(t => t.id === item.techId) || {}).name || 'dispatch'}. Load another email to keep going.`, 'good');
    render();
    const row = document.querySelector(`[data-row="${item.id}"]`);
    if (row) { row.classList.add('new'); row.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  }

  function renderQueue() {
    els.qcount.textContent = queue.length;
    els.qclear.hidden = !queue.length;
    if (!queue.length) {
      els.queue.innerHTML = `<div class="q-empty muted">No tickets yet. Draft one above and click <b>Add to queue</b>. Tickets you add are saved in this browser only.</div>`;
      return;
    }
    const now = Date.now();
    els.queue.innerHTML = queue.map(q => {
      const t = S.techs.find(x => x.id === q.techId);
      const v = S.vendors.find(x => x.id === q.vendor) || {};
      const d = fmtDeadline(q.deadline, now);
      const due = q.calledAt
        ? `<span class="chip good">Called ${h(new Date(q.calledAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}</span>`
        : `<span class="chip ${d.cls} mono" data-countdown="${h(q.deadline)}">${h(d.text)}</span>`;
      return `<article class="q-row" data-row="${h(q.id)}">
        <div class="q-id mono">${h(q.id)}</div>
        <div class="q-main">
          <div class="q-name">${h(q.customer || 'Unknown customer')} <span class="urg sm ${URG_CLASS[q.urgency] || ''}">${h(q.urgency)}</span></div>
          <div class="q-meta muted">${h([q.trade, q.equipment ? q.equipment.split(/[,(]/)[0].trim() : '', q.address].filter(Boolean).join(' · '))}</div>
          <div class="q-meta muted">${h(v.short || '')}${q.claim ? ' · <span class="mono">' + h(q.claim) + '</span>' : v.claimPrefix ? ' · <span class="chip warn">claim # pending</span>' : ''}</div>
        </div>
        <div class="q-tech">${t ? `<span class="tech-av sm" style="--c:${h(t.color)}" title="${h(t.name)}" aria-hidden="true">${h(t.initials)}</span><span class="q-tname">${h(t.name)}</span>` : '<span class="muted">Unassigned</span>'}</div>
        <div class="q-due"><span class="q-due-k muted">First call</span>${due}</div>
        <div class="q-act">
          ${q.calledAt ? '' : `<button type="button" class="btn ghost small" data-call="${h(q.id)}">Mark called</button>`}
          <button type="button" class="x" data-del="${h(q.id)}" aria-label="Remove ${h(q.id)} from queue">×</button>
        </div>
      </article>`;
    }).join('');
  }
  els.queue.addEventListener('click', e => {
    const c = e.target.closest('[data-call]'), d = e.target.closest('[data-del]');
    if (c) { const q = queue.find(x => x.id === c.dataset.call); if (q) q.calledAt = new Date().toISOString(); }
    else if (d) { queue = queue.filter(x => x.id !== d.dataset.del); }
    else return;
    store.set(QKEY, queue);
    renderQueue();
    if (d) render();
  });
  els.qclear.addEventListener('click', () => {
    if (!confirm('Clear all tickets from the demo queue?')) return;
    queue = [];
    store.set(QKEY, queue);
    renderQueue();
    render();
  });

  // Live countdowns
  setInterval(() => {
    const now = Date.now();
    document.querySelectorAll('[data-countdown]').forEach(el => {
      const d = fmtDeadline(el.dataset.countdown, now);
      el.textContent = d.text;
      if (el.classList.contains('chip')) el.className = 'chip mono ' + d.cls;
    });
  }, 30000);

  // ------------------------------------------------------------ start
  renderQueue();
  loadSample(0);
  run();
})();
