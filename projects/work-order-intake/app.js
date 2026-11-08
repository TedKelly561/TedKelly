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
  const TO_FOLLOW_RE = /\bclaim\b[^.\n]{0,25}?\b(?:to follow|will follow|to come|pending|tbd|not (?:yet )?(?:assigned|issued))\b/i;
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
    const { text, subject, vendor, claim, urgency, age, base, phones, phoneRaw, address, name, existing } = ctx;
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
    if (!phones.length) add('bad', phoneRaw ? `Phone number looks incomplete ("${phoneRaw}"): reply to sender for a callback number` : 'No phone number found: reply to sender for a callback number');
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
    // A phone line that is not a valid number (missing digit, typo) is kept as-is so validation can explain it.
    let phoneRaw = '';
    if (!phones.length) {
      const lab = labelled(body, ['Best phone', 'Phone number', 'Phone', 'Cell', 'Mobile', 'Tel', 'Telephone', 'Callback number', 'Contact number']);
      const m = lab.match(/\+?[\d(][\d()\s.-]{5,}\d/);
      if (m) phoneRaw = clean(m[0]);
    }
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
      phones, phoneRaw, address: addr.street, name: nameRes.value, existing,
    });

    const phoneText = phones.map((p, i) => p.number + (p.kind && i > 0 ? ' (' + p.kind + ')' : '')).join(', ');
    return {
      fields: {
        customer: field(nameRes.value, nameRes.status),
        phone: phoneText ? field(phoneText, 'found') : { value: phoneRaw, status: 'review', note: '' },
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
      claimToFollow: !claimRes.claim && TO_FOLLOW_RE.test(text),
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
    const out = fromClaude(parseClaudeJson(txt), raw, S, now, Date.now() - t0);
    out.claude = { inChars: p.system.length + p.user.length, outChars: txt.length, usage: data.usage || null };
    return out;
  }

  // ================================================================ M1 pipeline
  // extract -> validate every field -> duplicate & return-visit check -> decide -> act.
  // Pure functions (no DOM), so the whole pipeline can be tested in Node.

  const SERVICE_AREA = { from: 80011, to: 80016, label: '80011–80016' };
  const CLAIM_FORMATS = {
    V1: { re: /^NS-\d{6}$/, label: 'NS-######' },
    V2: { re: /^BP\d{7}$/, label: 'BP#######' },
    V3: { re: /^HAC-\d{5}$/, label: 'HAC-#####' },
  };
  const TRADES = ['HVAC', 'Plumbing', 'Appliance'];
  const OPEN = ['new', 'scheduled', 'en_route', 'in_progress', 'waiting_parts'];
  const LOW_CONFIDENCE = 0.6;
  const isToFollow = s => /^\s*(?:to follow|tbd|pending|to come|will follow)\s*\.?\s*$/i.test(s || '');
  const digitsOf = s => String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const firstPhone = s => String(s || '').split(/[,;/]/)[0].replace(/\((?:alt|cell|home|work)\)/i, '').trim();
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const ABBR = { street: 'st', avenue: 'ave', drive: 'dr', lane: 'ln', road: 'rd', court: 'ct', place: 'pl', parkway: 'pkwy', terrace: 'ter', trail: 'trl', boulevard: 'blvd', circle: 'cir' };
  const normAddr = s => clean(String(s || '').toLowerCase().replace(/[.,#]/g, ' ')).split(' ').map(w => ABBR[w] || w).join(' ');
  const dayStart = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const daysAgo = (iso, now) => Math.round((dayStart(now) - dayStart(iso)) / 86400000);
  const agoText = n => (n <= 0 ? 'today' : n === 1 ? 'yesterday' : n + ' days ago');

  // Main equipment named in a piece of text ("Washer drain pump" -> "Washer").
  function equipmentOf(text) {
    const r = scoreTrade(String(text || ''));
    const hit = r.hits.slice().sort((a, b) => b.w - a.w || a.index - b.index)[0];
    return hit ? hit.name : '';
  }

  // Flatten a parse result into the editable ticket the rules run on.
  function toTicket(r) {
    const t = {};
    Object.keys(r.fields).forEach(k => (t[k] = r.fields[k].value));
    let base = r.equipmentBase || equipmentOf(t.equipment) || '';
    t.equipmentBase = base ? base.charAt(0).toUpperCase() + base.slice(1) : '';
    t.claimToFollow = !!r.claimToFollow;
    t.flags = (r.flags || []).slice();
    t.edited = {};
    return t;
  }

  // ---------------------------------------------------------------- 1. validation rules
  // Every rule returns pass / warn / fail with a plain-English reason. A failed hard rule
  // means the ticket cannot be created automatically.
  function validate(t, S) {
    const R = [];
    const add = (id, field, label, status, reason) => R.push({ id, field, label, status, reason, hard: true });
    const v = S.vendors.find(x => x.id === t.vendor) || {};

    const name = clean(t.customer);
    if (!name) add('name', 'customer', 'Customer name present', 'fail', 'No customer name in the email.');
    else if (!/[A-Za-z]{2,}/.test(name)) add('name', 'customer', 'Customer name present', 'fail', `"${name}" does not look like a name.`);
    else add('name', 'customer', 'Customer name present', 'pass', `Found "${name}".`);

    const p = firstPhone(t.phone), d = digitsOf(p);
    if (!p) add('phone', 'phone', 'Phone has 10 digits', 'fail', 'No phone number. Nobody can call the customer.');
    else if (d.length !== 10) add('phone', 'phone', 'Phone has 10 digits', 'fail', `"${p}" has ${plural(d.length, 'digit')}; a phone number needs 10.`);
    else add('phone', 'phone', 'Phone has 10 digits', 'pass', `${normalizePhone(d)} is a full 10-digit number.`);

    const a = clean(t.address);
    const am = a.match(/^(\d+[A-Za-z]?)\s+((?:[NSEW]\.?\s+)?[A-Za-z][A-Za-z0-9 .'’-]*[A-Za-z0-9])/);
    if (!a) add('address', 'address', 'Address has number + street', 'fail', 'No service address. The tech has nowhere to go.');
    else if (!am) add('address', 'address', 'Address has number + street', 'fail', `"${a}" is missing a house number or street name.`);
    else add('address', 'address', 'Address has number + street', 'pass', `House number ${am[1]}, street "${am[2].replace(/,.*$/, '')}".`);

    const z = clean(t.zip);
    const zipOk = /^\d{5}$/.test(z);
    if (!z) add('zip', 'zip', 'ZIP is 5 digits', 'fail', 'No ZIP code.');
    else if (!zipOk) add('zip', 'zip', 'ZIP is 5 digits', 'fail', `"${z}" is not a 5-digit ZIP.`);
    else add('zip', 'zip', 'ZIP is 5 digits', 'pass', `${z} is 5 digits.`);
    if (!zipOk) add('area', 'zip', 'ZIP is in the service area', 'fail', `Cannot check the service area (${SERVICE_AREA.label}) without a valid ZIP.`);
    else if (+z >= SERVICE_AREA.from && +z <= SERVICE_AREA.to) add('area', 'zip', 'ZIP is in the service area', 'pass', `${z} is inside the service area (${SERVICE_AREA.label}).`);
    else add('area', 'zip', 'ZIP is in the service area', 'fail', `${z} is outside the service area (${SERVICE_AREA.label}).`);

    const c = clean(t.claim).toUpperCase();
    const fmt = CLAIM_FORMATS[v.id];
    const cl = 'Claim # matches vendor format';
    if (!v.claimPrefix || !fmt) add('claim', 'claim', cl, 'pass', 'Direct customer: no claim number needed.');
    else if (c && fmt.re.test(c)) add('claim', 'claim', cl, 'pass', `${c} matches ${v.short}'s format (${fmt.label}).`);
    else if ((!c && t.claimToFollow) || isToFollow(c)) add('claim', 'claim', cl, 'warn', `${v.short} says the claim number is "to follow". Allowed, but get it before dispatch.`);
    else if (!c) add('claim', 'claim', cl, 'fail', `${v.short} jobs need a claim number (${fmt.label}) or a note that it is "to follow".`);
    else add('claim', 'claim', cl, 'fail', `"${c}" does not match ${v.short}'s format (${fmt.label}).`);

    const tr = clean(t.trade);
    if (TRADES.includes(tr)) add('trade', 'trade', 'Trade is HVAC, Plumbing or Appliance', 'pass', `${tr} is a trade Summit covers.`);
    else add('trade', 'trade', 'Trade is HVAC, Plumbing or Appliance', 'fail', tr ? `"${tr}" is not a trade Summit covers.` : 'Could not tell the trade from the email.');

    const pr = clean(t.problem);
    if (pr.length >= 8) add('problem', 'problem', 'Problem described', 'pass', 'The tech knows what is wrong before arriving.');
    else add('problem', 'problem', 'Problem described', 'fail', 'No description of the problem.');
    return R;
  }

  // ---------------------------------------------------------------- 2. duplicate & return-visit check
  // duplicate: same claim number on an open job, or same phone/address with an open job
  //            for the same trade and equipment.
  // return visit (recall): same customer, same trade and equipment, job completed in the last 30 days.
  // related:   the customer has another open job for something else (shown, not blocking).
  function checkHistory(t, S, ctx) {
    ctx = ctx || {};
    const now = ctx.now ? new Date(ctx.now) : new Date();
    const phones = new Set(String(t.phone || '').split(/[,;/]/).map(digitsOf).filter(d => d.length === 10));
    const addr = normAddr(t.address);
    const claim = clean(t.claim).toUpperCase();
    const hasClaim = !!claim && !isToFollow(claim);
    const eq = equipmentOf([t.equipmentBase, t.equipment].join(' ')) || equipmentOf(t.problem);
    const out = { duplicates: [], recalls: [], related: [], customer: null };
    const phoneHit = ph => String(ph || '').split(/[,;/]/).some(x => phones.has(digitsOf(x)));
    const addrHit = a => !!addr && !!a && normAddr(a) === addr;
    out.customer = S.customers.find(c => phoneHit(c.phone) || addrHit(c.address)) || null;

    const recs = S.jobs.map(j => {
      const c = S.customers.find(x => x.id === j.customerId) || {};
      return { id: j.id, source: 'job', customer: c.name, phone: c.phone, address: c.address, claim: j.claim, trade: j.trade, issue: j.issue,
        status: j.status, open: OPEN.includes(j.status), createdAt: j.createdAt, completedAt: j.completedAt, techId: j.techId, firstCallAt: j.firstCallAt, vendorId: j.vendorId };
    });
    (ctx.tickets || []).forEach(q => recs.push({ id: q.id, source: 'ticket', customer: q.customer, phone: q.phone, address: q.address, claim: q.claim, trade: q.trade,
      issue: q.problem || q.equipment, equipment: q.equipment, status: 'new', open: true, createdAt: q.createdAt, techId: q.techId, firstCallAt: q.calledAt, vendorId: q.vendor }));
    (ctx.pending || []).forEach(p => recs.push({ id: p.id, source: 'person', customer: p.ticket.customer, phone: p.ticket.phone, address: p.ticket.address, claim: p.ticket.claim,
      trade: p.ticket.trade, issue: p.ticket.problem, equipment: p.ticket.equipment, status: 'waiting for a person', open: true, createdAt: p.receivedAt, vendorId: p.ticket.vendor }));

    for (const r of recs) {
      if (ctx.excludeId && r.id === ctx.excludeId) continue;
      const sameClaim = hasClaim && r.claim && String(r.claim).toUpperCase() === claim;
      const byPhone = phoneHit(r.phone), byAddr = addrHit(r.address);
      const rEq = equipmentOf((r.equipment || '') + ' ' + (r.issue || ''));
      const sameTrade = r.trade === t.trade;
      const sameEq = !eq || !rEq || eq === rEq;
      const days = r.completedAt ? daysAgo(r.completedAt, now) : null;
      const m = { id: r.id, source: r.source, customer: r.customer, issue: r.issue, status: r.status, trade: r.trade, equipment: rEq, techId: r.techId,
        createdAt: r.createdAt, completedAt: r.completedAt, days, firstCallAt: r.firstCallAt || null, claim: r.claim || '', vendorId: r.vendorId, open: r.open };
      const what = rEq ? rEq.toLowerCase() : r.trade.toLowerCase();
      const how = [byPhone && 'phone', byAddr && 'address'].filter(Boolean).join(' and ');
      if (sameClaim && r.open) { out.duplicates.push(Object.assign(m, { why: `Same claim number ${claim} as an open ${r.source === 'person' ? 'item' : 'job'}` })); continue; }
      if (sameClaim && days != null && days <= 30) { out.recalls.push(Object.assign(m, { why: `Same claim ${claim}; that ${what} job was completed ${agoText(days)}` })); continue; }
      if (sameClaim) { out.duplicates.push(Object.assign(m, { why: `Claim ${claim} was already used on a closed job` })); continue; }
      if (!byPhone && !byAddr) continue;
      if (r.open && sameTrade && sameEq) out.duplicates.push(Object.assign(m, { why: `Same ${how}, with an open ${r.trade} job for the ${what}` }));
      else if (!r.open && days != null && days <= 30 && sameTrade && sameEq) out.recalls.push(Object.assign(m, { why: `Same ${how}; ${what} job completed ${agoText(days)}` }));
      else if (r.open) out.related.push(Object.assign(m, { why: `Open ${r.trade} job for a different ${sameTrade ? 'item' : 'trade'}: not a duplicate` }));
    }
    return out;
  }

  // ---------------------------------------------------------------- 3. confidence
  // Share of key fields read directly from the email (found = 1, inferred = 0.7, missing = 0).
  // Fields a person has typed count as found.
  function confidence(fields, edited) {
    const keys = ['customer', 'phone', 'address', 'zip', 'trade', 'problem', 'equipment'];
    const w = { found: 1, inferred: 0.7, review: 0 };
    const sum = keys.reduce((s, k) => s + ((edited && edited[k]) ? 1 : (w[(fields[k] || {}).status] ?? 0.7)), 0);
    return Math.round((sum / keys.length) * 100) / 100;
  }

  // ---------------------------------------------------------------- 4. decision
  const TRADE_TECH = { HVAC: 'HVAC tech', Plumbing: 'plumber', Appliance: 'appliance tech' };
  function decide(t, rules, history, conf, S) {
    const reasons = [], steps = [];
    const v = S.vendors.find(x => x.id === t.vendor) || {};
    const techName = id => ((S.techs.find(x => x.id === id) || {}).name || 'the same tech');
    const fails = rules.filter(r => r.hard && r.status === 'fail');
    const phoneOk = !fails.some(r => r.id === 'phone') && firstPhone(t.phone);
    if (t.urgency === 'Emergency') {
      reasons.push({ code: 'emergency', label: 'Emergency', text: 'Emergency: a person should call the customer right away' });
      steps.push(`Call ${t.customer || 'the customer'} now${phoneOk ? ' on ' + firstPhone(t.phone) : ''}, confirm the leak or hazard is contained, then approve and dispatch the on-call ${TRADE_TECH[t.trade] || 'tech'}.`);
    }
    if (history.duplicates.length) {
      const d = history.duplicates[0];
      reasons.push({ code: 'duplicate', label: 'Duplicate', text: `Possible duplicate of ${history.duplicates.map(x => x.id).join(', ')}: ${d.why.charAt(0).toLowerCase() + d.why.slice(1)}` });
      const noCall = d.open && !d.firstCallAt && d.source !== 'person';
      steps.push(`Do not create a second ticket. Add this email to ${d.id}${noCall ? ' (no first call is logged on it yet, so call the customer today)' : ''}, then reject this one as a duplicate.`);
    }
    if (history.recalls.length) {
      const r = history.recalls[0];
      reasons.push({ code: 'recall', label: 'Return visit', text: `Return visit: ${r.id} (${r.issue}) was completed ${agoText(r.days)}. Warranty recall risk.` });
      steps.push(`Book it as a recall on ${r.id}: send ${techName(r.techId)} back if possible, no new trip charge, and tell ${v.claimPrefix ? v.short : 'the customer'} it is a repeat visit.`);
    }
    const FIX = {
      name: 'Find out who the customer is (reply to the sender).',
      phone: 'Reply to the sender and ask for a 10-digit callback number.',
      address: 'Ask for the full service address (house number and street).',
      zip: 'Ask for the ZIP code.',
      area: `Check the address. If ${clean(t.zip) || 'the ZIP'} is right, reply that it is outside the service area and reject, or refer it out.`,
      claim: `Look up the claim in the ${v.short || 'vendor'} portal and enter it in the ${(CLAIM_FORMATS[v.id] || {}).label || 'right'} format.`,
      trade: 'Pick the trade: HVAC, Plumbing or Appliance.',
      problem: 'Ask what is wrong so the tech can bring the right parts.',
    };
    fails.forEach(r => {
      reasons.push({ code: 'rule', label: 'Failed check', field: r.field, text: r.reason });
      if (FIX[r.id] && !(r.id === 'zip' && fails.some(x => x.id === 'area' && clean(t.zip)))) steps.push(FIX[r.id]);
    });
    if (conf < LOW_CONFIDENCE) {
      reasons.push({ code: 'confidence', label: 'Low confidence', text: `Low confidence (${Math.round(conf * 100)}%): several fields were guessed, not read` });
      steps.push('Check the fields marked "inferred" or "needs review" against the email.');
    }
    const seen = new Set();
    const uniqSteps = steps.filter(s => (seen.has(s) ? false : seen.add(s)));
    return {
      route: reasons.length ? 'person' : 'create',
      reasons, steps: uniqSteps,
      canApprove: fails.length === 0,
      summary: reasons.length ? reasons.map(r => r.label).filter((x, i, a) => a.indexOf(x) === i).join(', ') : 'all checks passed',
    };
  }

  function evaluate(t, r, S, ctx) {
    const rules = validate(t, S);
    const history = checkHistory(t, S, ctx);
    const conf = confidence(r.fields, t.edited);
    const decision = decide(t, rules, history, conf, S);
    const counts = { pass: rules.filter(x => x.status !== 'fail').length, fail: rules.filter(x => x.status === 'fail').length, warn: rules.filter(x => x.status === 'warn').length };
    return { rules, history, conf, decision, counts };
  }

  // ---------------------------------------------------------------- 5. cost per email
  // ASSUMED list price for the model used here. Estimate only; check current pricing.
  // typicalOutputTokens = the JSON reply (~225 tokens) plus room for the model's own thinking,
  // which is billed as output.
  const PRICING = { model: CLAUDE_MODEL, inputPerMTok: 2, outputPerMTok: 10, charsPerToken: 4, typicalOutputTokens: 650, asOf: 'Oct 2026' };
  const usd = (inTok, outTok) => (inTok * PRICING.inputPerMTok + outTok * PRICING.outputPerMTok) / 1e6;
  function claudeCostFor(info) {
    if (info.usage && info.usage.input_tokens != null) {
      return { inTok: info.usage.input_tokens, outTok: info.usage.output_tokens || 0, usd: usd(info.usage.input_tokens, info.usage.output_tokens || 0), basis: 'tokens reported by the API' };
    }
    const inTok = Math.ceil(info.inChars / PRICING.charsPerToken), outTok = Math.ceil(info.outChars / PRICING.charsPerToken);
    return { inTok, outTok, usd: usd(inTok, outTok), basis: '~4 characters per token' };
  }
  // What this email would cost if Claude read it (prompt size known, reply size typical).
  function estimateClaude(raw, S) {
    const p = claudePrompt(raw, S);
    const inTok = Math.ceil((p.system.length + p.user.length) / PRICING.charsPerToken), outTok = PRICING.typicalOutputTokens;
    return { inTok, outTok, usd: usd(inTok, outTok), basis: '~4 characters per token, typical reply' };
  }

  // ---------------------------------------------------------------- extra sample emails (M1)
  // Fictional. Built to show the safety rules: a resend of an open job, a return visit
  // and an email that fails validation.
  const EXTRA_SAMPLES = [
    {
      label: 'Resend of an open job (duplicate)',
      from: 'dispatch@northstar-warranty.example',
      subject: 'REMINDER: Service Request - Claim NS-448099 - Appliance',
      body: `Hello Summit Home Services,

This is a reminder for a service request assigned to you.

Claim #: NS-448099
Contract holder: James Thornton
Property: 1501 Summit Pkwy, 80016
Phone: (555) 013-2210
Item: Dishwasher
Customer reports: dishes still dirty after a full cycle and a loud hum. Customer says nobody has called yet.

Please make first contact within 24 hours and update the portal.

Northstar Home Warranty Dispatch`,
    },
    {
      label: 'Same problem again (return visit)',
      from: 'dispatch@northstar-warranty.example',
      subject: 'New Service Request - Claim NS-448641 - Appliance',
      body: `Hello Summit Home Services,

You have been assigned a new service request.

Claim #: NS-448641
Contract holder: Alicia Moreno
Property: 1420 Maple Ave, 80011
Phone: (555) 013-2201
Item: Refrigerator - top freezer
Customer reports: fridge not cooling again, fresh food side is warm. Same problem was repaired this week.

Please make first contact within 24 hours and update the portal.

Northstar Home Warranty Dispatch`,
    },
    {
      label: 'Out of area, phone missing a digit',
      from: 'dwight.okonkwo@example.com',
      subject: 'furnace making a bang',
      body: `Hello, our furnace makes a loud bang when it kicks on and then the air smells dusty for a while. its a Carrier, maybe 15 years old, in the basement.

Address is 9 Lantern Ln, 80022
Phone: 555-013-881
Call anytime after 3.

Thanks, Dwight Okonkwo`,
    },
  ];

  const api = {
    parse, suggestTech, draftText, normalizePhone, extractWithClaude, fromClaude, parseClaudeJson, claudePrompt, CLAUDE_MODEL, splitHeaders,
    toTicket, validate, checkHistory, confidence, decide, evaluate, equipmentOf, isToFollow,
    claudeCostFor, estimateClaude, PRICING, SERVICE_AREA, CLAIM_FORMATS, LOW_CONFIDENCE, SAMPLES: EXTRA_SAMPLES,
  };
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
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const h = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const K = { queue: 'summit-intake-queue-v1', person: 'summit-intake-person-v1', log: 'summit-intake-log-v1', shadow: 'summit-intake-shadow-v1', tab: 'summit-intake-tab-v1', key: 'summit-intake-claude-key' };
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  const MONTHLY = 150;

  const store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked: data lives in memory */ } },
  };
  const session = {
    get(k) { try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set(k, v) { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const arr = v => (Array.isArray(v) ? v : []);

  let queue = arr(store.get(K.queue, []));     // tickets created
  let person = arr(store.get(K.person, []));   // needs-a-person items (open + handled)
  let log = arr(store.get(K.log, []));         // activity log, newest first
  const firstVisit = store.get(K.shadow, null) === null;
  let shadow = store.get(K.shadow, 'on') !== 'off'; // default ON on the first visit
  let cur = null;                              // the run shown in the result panel
  let memKey = session.get(K.key);
  let source = null;                           // { kind: 'pdf', name, pages } when the textarea holds PDF text

  const els = {
    email: $('#email'), create: $('#create'), clear: $('#clear-email'), samples: $('#samples'),
    out: $('#ticket'), status: $('#status'), cost: $('#cost'),
    shadow: $('#shadow'), shadowState: $('#shadow-state'), shadowDesc: $('#shadow-desc'),
    useClaude: $('#use-claude'), key: $('#api-key'), remember: $('#remember-key'), keyStatus: $('#key-status'),
    queue: $('#queue'), person: $('#person'), log: $('#log'),
    nT: $('#n-tickets'), nP: $('#n-person'), nL: $('#n-log'), qclear: $('#qclear'), pclear: $('#pclear'), lclear: $('#lclear'), logSum: $('#log-sum'),
    pdfSample: $('#pdf-sample'), pdfFile: $('#pdf-file'), pdfStatus: $('#pdf-status'),
  };
  const save = () => { store.set(K.queue, queue); store.set(K.person, person); store.set(K.log, log); };
  const openPerson = () => person.filter(p => p.status === 'open');
  const vendorOf = id => S.vendors.find(v => v.id === id) || S.vendors[S.vendors.length - 1];
  const techOf = id => S.techs.find(t => t.id === id);
  const money = (n, d = 3) => '$' + Number(n || 0).toFixed(d);
  const timeOf = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const clock = iso => new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const dateOf = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const URG_CLASS = { Emergency: 'bad', High: 'warn', Normal: 'good' };

  // ------------------------------------------------------------ shadow mode
  function syncShadow() {
    els.shadow.checked = shadow;
    els.shadowState.textContent = shadow ? 'ON' : 'OFF';
    document.body.classList.toggle('is-shadow', shadow);
    els.shadowDesc.innerHTML = shadow
      ? '<b>Shadow mode: logs what it would do, writes nothing.</b> Run it next to your current process for a week, compare, then switch it off.'
      : '<b>Live:</b> clean emails become tickets; anything unclear goes to <i>Needs a person</i>. Turn shadow mode back on any time.';
  }
  els.shadow.addEventListener('change', () => {
    shadow = els.shadow.checked;
    store.set(K.shadow, shadow ? 'on' : 'off');
    syncShadow();
    addLog({ kind: 'system', title: shadow ? 'Shadow mode turned ON: nothing will be written' : 'Shadow mode turned OFF: the tool will now act', steps: [] });
    if (cur) render();
    renderLists();
  });

  // ------------------------------------------------------------ samples
  const SAMPLES = S.sampleEmails.concat(I.SAMPLES);
  els.samples.innerHTML = SAMPLES.map((e, i) => {
    const v = S.vendors.find(x => x.claimPrefix && e.from.toLowerCase().includes(x.short.toLowerCase()));
    const who = v ? v.short : e.from.split('@')[0].split(/[._]/)[0];
    return `<button type="button" class="mail" data-i="${i}" aria-label="Load sample: ${h(e.label)}">
      <span class="mail-av" aria-hidden="true">${h(who.charAt(0).toUpperCase())}</span>
      <span class="mail-txt"><span class="mail-from">${h(v ? v.name : e.from)}</span>
      <span class="mail-subj">${h(e.subject)}</span>
      <span class="mail-tag">${h(e.label)}</span></span></button>`;
  }).join('');
  const emailText = e => `From: ${e.from}\nSubject: ${e.subject}\n\n${e.body}`;
  const markSample = i => $$('.mail', els.samples).forEach((b, j) => b.classList.toggle('active', j === i));
  function loadSample(i) { els.email.value = emailText(SAMPLES[i]); source = null; markSample(i); }
  els.samples.addEventListener('click', e => {
    const b = e.target.closest('.mail');
    if (!b) return;
    loadSample(Number(b.dataset.i));
    run();
  });
  els.clear.addEventListener('click', () => { els.email.value = ''; source = null; markSample(-1); els.email.focus(); });
  els.email.addEventListener('input', () => { if (source) source = null; markSample(-1); });

  // ------------------------------------------------------------ PDF intake (pdf.js, loaded on first use)
  let pdfLib = null;
  function loadPdfJs() {
    if (pdfLib) return pdfLib;
    pdfLib = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDFJS + 'pdf.min.js';
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; resolve(window.pdfjsLib); };
      s.onerror = () => { pdfLib = null; reject(new Error('could not load the PDF reader')); };
      document.head.appendChild(s);
    });
    return pdfLib;
  }
  // Rebuild lines from text positions so "Claim #:" and its value end up on one line.
  async function pdfText(buf) {
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: buf }).promise;
    const out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      const rows = [];
      tc.items.filter(it => it.str && it.str.trim()).forEach(it => {
        const y = it.transform[5], x = it.transform[4];
        let row = rows.find(r => Math.abs(r.y - y) < 3);
        if (!row) rows.push(row = { y, items: [] });
        row.items.push({ x, s: it.str });
      });
      rows.sort((a, b) => b.y - a.y).forEach(r => out.push(r.items.sort((a, b) => a.x - b.x).map(i => i.s.trim()).join(' ').replace(/\s+/g, ' ')));
      out.push('');
    }
    return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), pages: doc.numPages };
  }
  async function intakePdf(buf, name) {
    els.pdfStatus.textContent = 'Reading PDF…';
    try {
      const { text, pages } = await pdfText(buf);
      if (!text) throw new Error('no text found (a scanned image needs OCR)');
      const first = text.split('\n').find(l => l.trim()) || 'PDF work order';
      els.email.value = `From: ${name} (PDF upload)\nSubject: ${first}\n\n${text}`;
      source = { kind: 'pdf', name, pages };
      markSample(-1);
      els.pdfStatus.textContent = `Read ${pages} page${pages === 1 ? '' : 's'} from ${name}.`;
      await run();
    } catch (err) {
      els.pdfStatus.textContent = 'Could not read that PDF: ' + err.message + '.';
      addLog({ kind: 'system', title: `PDF ${name} could not be read: ${err.message}. Nothing was created; please handle it by hand.`, steps: [], warn: true });
    }
  }
  els.pdfSample.addEventListener('click', async () => {
    els.pdfStatus.textContent = 'Fetching sample PDF…';
    try {
      const res = await fetch('samples/sample-work-order.pdf');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await intakePdf(await res.arrayBuffer(), 'sample-work-order.pdf');
    } catch (err) { els.pdfStatus.textContent = 'Could not load the sample PDF: ' + err.message; }
  });
  els.pdfFile.addEventListener('change', async () => {
    const f = els.pdfFile.files[0];
    if (!f) return;
    await intakePdf(await f.arrayBuffer(), f.name);
    els.pdfFile.value = '';
  });

  // ------------------------------------------------------------ Claude key
  if (memKey) { els.key.value = memKey; els.remember.checked = true; }
  function syncKey() {
    memKey = els.key.value.trim();
    session.set(K.key, els.remember.checked ? memKey : '');
    els.keyStatus.textContent = memKey ? (els.useClaude.checked ? 'Key set. Next email will use Claude.' : 'Key set. Tick "Use Claude" to switch readers.') : 'No key entered. The built-in reader is used.';
  }
  els.key.addEventListener('input', syncKey);
  els.remember.addEventListener('change', syncKey);
  els.useClaude.addEventListener('change', syncKey);
  syncKey();

  // ------------------------------------------------------------ ids
  function nextTicketNo() {
    const nums = S.jobs.map(j => j.id).concat(queue.map(q => q.id)).map(id => Number(String(id).replace(/\D/g, '')) || 0);
    return 'SH-' + (Math.max(...nums) + 1);
  }
  function nextPersonId() {
    const n = person.map(p => Number(String(p.id).replace(/\D/g, '')) || 0);
    return 'IN-' + String((n.length ? Math.max(...n) : 0) + 1).padStart(3, '0');
  }
  const queueJobs = () => queue.filter(q => q.techId).map(q => ({ techId: q.techId, status: 'scheduled', scheduledStart: S.today, durationHrs: 2 }));

  // ------------------------------------------------------------ status line
  function setStatus(msg, kind) { els.status.textContent = msg || ''; els.status.className = 'status' + (kind ? ' ' + kind : ''); }

  // ------------------------------------------------------------ the pipeline run
  async function run() {
    const raw = els.email.value.trim();
    if (!raw) { setStatus('Paste an email first, or pick one from the inbox.', 'warn'); els.email.focus(); return; }
    els.create.disabled = true;
    els.out.classList.add('loading');
    const receivedAt = new Date().toISOString();
    let result, note = '';
    if (els.useClaude.checked && memKey) {
      setStatus('Asking Claude to read the email…');
      try { result = await I.extractWithClaude(raw, memKey, S); }
      catch (err) { result = I.parse(raw, S); note = `Claude request failed (${err.message}). Used the built-in reader instead.`; }
    } else {
      await new Promise(r => setTimeout(r, 220)); // brief beat so the change is visible
      result = I.parse(raw, S);
      if (els.useClaude.checked && !memKey) note = 'No API key entered, so the built-in reader was used.';
    }
    const t = I.toTicket(result);
    const best = I.suggestTech(t.trade, S, queueJobs())[0];
    t.techId = best ? best.tech.id : '';
    t.sms = I.draftText(t, S);
    const cost = result.engine === 'claude' && result.claude ? I.claudeCostFor(result.claude) : { usd: 0, inTok: 0, outTok: 0, basis: 'built-in reader' };
    const est = I.estimateClaude(raw, S);
    cur = { raw, meta: result, ticket: t, mode: 'draft', refId: null, receivedAt, source, cost, est };
    cur.ev = evaluateCur();
    act();
    els.create.disabled = false;
    els.out.classList.remove('loading');
    render();
    renderLists();
    if (note) setStatus(note, 'warn');
  }

  function evaluateCur() {
    return I.evaluate(cur.ticket, cur.meta, S, { tickets: queue, pending: openPerson(), excludeId: cur.refId });
  }

  // Decide and act (or, in shadow mode, only log what it would do).
  function act() {
    const { ev, ticket: t } = cur;
    const d = ev.decision;
    const primary = d.reasons[0];
    const id = nextTicketNo();
    let action;
    if (shadow) {
      cur.mode = 'shadow';
      action = d.route === 'create' ? `WOULD create ticket ${id}` : `WOULD send to a person: ${primary.text}`;
      setStatus(d.route === 'create' ? `Shadow mode: would create ${id}. Nothing was written.` : 'Shadow mode: would send this to a person. Nothing was written.', 'good');
    } else if (d.route === 'create') {
      const item = createTicket(t, id, cur.meta);
      cur.mode = 'created'; cur.refId = item.id;
      action = `Created ticket ${item.id}, assigned to ${(techOf(item.techId) || {}).name || 'dispatch'}`;
      setStatus(`${item.id} created. Load another email to keep going.`, 'good');
    } else {
      const p = {
        id: nextPersonId(), status: 'open', receivedAt: cur.receivedAt, raw: cur.raw, source: cur.source,
        subject: cur.meta.subject, from: cur.meta.from, engine: cur.meta.engine, meta: cur.meta,
        ticket: t, reasons: d.reasons, steps: d.steps, rules: ev.rules, history: slimHistory(ev.history),
      };
      person.unshift(p);
      cur.mode = 'person'; cur.refId = p.id;
      action = `Sent to Needs a person as ${p.id}: ${primary.text}`;
      setStatus(`Sent to Needs a person (${p.id}): ${d.summary}.`, 'warn');
    }
    addLog({ kind: 'run', title: action, shadow, route: d.route, ref: cur.refId, steps: traceSteps(action), cost: cur.cost.usd, est: cur.est.usd, engine: cur.meta.engine, subject: cur.meta.subject });
  }
  const slimHistory = hs => ({ duplicates: hs.duplicates, recalls: hs.recalls, related: hs.related });

  function traceSteps(action) {
    const { meta, ev, cost, receivedAt } = cur;
    const f = Object.values(meta.fields);
    const read = f.filter(x => x.status !== 'review').length;
    const fails = ev.rules.filter(r => r.status === 'fail');
    const hs = ev.history;
    const what = cur.source && cur.source.kind === 'pdf' ? `PDF work order received: ${cur.source.name}` : `Email received from ${meta.from || 'unknown sender'}`;
    const hist = hs.duplicates.length ? `matches ${hs.duplicates.map(x => x.id).join(', ')} (${hs.duplicates[0].why})`
      : hs.recalls.length ? `return visit: ${hs.recalls[0].id} ${hs.recalls[0].issue}, completed ${dateOf(hs.recalls[0].completedAt)}`
      : hs.related.length ? `no duplicate; ${hs.related.length} other open job${hs.related.length === 1 ? '' : 's'} for this customer` : 'no duplicates, no recent visits';
    return [
      { k: 'received', at: receivedAt, t: what + (meta.subject ? ` · "${meta.subject}"` : '') },
      { k: 'extracted', t: `${meta.engine === 'claude' ? 'Claude (' + I.CLAUDE_MODEL + ')' : 'Built-in reader'} filled ${read} of ${f.length} fields in ${meta.engine === 'claude' ? (meta.ms / 1000).toFixed(1) + ' s' : meta.ms + ' ms'} · cost ${money(cost.usd, 4)}` },
      { k: 'validated', t: `${ev.counts.pass} pass / ${ev.counts.fail} fail${ev.counts.warn ? ' (' + ev.counts.warn + ' warning)' : ''}${fails.length ? ': ' + fails.map(r => r.label.toLowerCase()).join(', ') : ''}` },
      { k: 'checked', t: 'Duplicate & return-visit check: ' + hist },
      { k: 'decision', t: ev.decision.route === 'create' ? 'Create the ticket automatically' : `Send to a person (${ev.decision.summary.toLowerCase()})` },
      { k: 'action', t: action },
    ];
  }

  function createTicket(t, id, meta) {
    const v = vendorOf(t.vendor);
    let hours = v.firstCallHours;
    const within = ((cur && cur.raw) || '').match(/within\s+(\d{1,3})\s*(?:hours|hrs?)\b/i);
    if (within && v.claimPrefix) hours = Number(within[1]);
    if (t.urgency === 'Emergency') hours = Math.min(hours, 1);
    const item = {
      id, customer: t.customer, phone: t.phone, address: t.address, zip: t.zip, vendor: t.vendor, claim: t.claim, trade: t.trade,
      equipment: t.equipment, problem: t.problem, urgency: t.urgency, techId: t.techId, sms: t.sms, flags: (t.flags || []).map(f => f.msg),
      deadline: new Date(Date.now() + hours * 3600000).toISOString(), createdAt: new Date().toISOString(), calledAt: null, engine: meta.engine,
    };
    queue.unshift(item);
    save();
    return item;
  }

  function addLog(e) {
    e.id = 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    e.at = new Date().toISOString();
    log.unshift(e);
    if (log.length > 200) log.length = 200;
    save();
    renderLists();
  }

  // ------------------------------------------------------------ person actions
  function reviewItem(id) {
    const p = person.find(x => x.id === id);
    if (!p) return;
    els.email.value = p.raw; source = p.source || null; markSample(-1);
    cur = { raw: p.raw, meta: p.meta, ticket: JSON.parse(JSON.stringify(p.ticket)), mode: p.status === 'open' ? 'person' : p.status, refId: p.id, receivedAt: p.receivedAt, source: p.source, cost: { usd: 0 }, est: I.estimateClaude(p.raw, S), item: p };
    cur.ticket.edited = cur.ticket.edited || {};
    cur.ev = evaluateCur();
    render();
    els.out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function approve() {
    const p = person.find(x => x.id === cur.refId);
    if (!p || p.status !== 'open' || shadow) return;
    cur.ev = evaluateCur();
    if (!cur.ev.decision.canApprove) return;
    const id = nextTicketNo();
    const edited = Object.keys(cur.ticket.edited || {}).filter(k => k !== 'techId');
    createTicket(cur.ticket, id, cur.meta);
    Object.assign(p, { status: 'approved', resolvedAt: new Date().toISOString(), ticketId: id, ticket: cur.ticket });
    cur.mode = 'approved'; cur.item = p;
    addLog({ kind: 'person', title: `Approved by a person: created ticket ${id} from ${p.id}`, ref: id, steps: [
      { k: 'person', t: `Reviewed ${p.id}: ${p.reasons.map(r => r.label).filter((x, i, a) => a.indexOf(x) === i).join(', ')}` },
      { k: 'validated', t: `${cur.ev.counts.pass} pass / ${cur.ev.counts.fail} fail${edited.length ? ' after fixing: ' + edited.join(', ') : ''}` },
      { k: 'action', t: `Created ticket ${id}` },
    ] });
    setStatus(`${p.id} approved: ticket ${id} created.`, 'good');
    render(); renderLists();
  }
  function reject(reason) {
    const p = person.find(x => x.id === (cur && cur.refId));
    if (!p || p.status !== 'open' || shadow) return;
    reason = (reason || '').trim() || 'No reason given';
    Object.assign(p, { status: 'rejected', resolvedAt: new Date().toISOString(), rejectReason: reason });
    cur.mode = 'rejected'; cur.item = p;
    addLog({ kind: 'person', title: `Rejected by a person: ${p.id} (${reason}). The email stays in the log.`, ref: p.id, steps: [
      { k: 'person', t: `Reviewed ${p.id}: ${p.reasons.map(r => r.label).filter((x, i, a) => a.indexOf(x) === i).join(', ')}` },
      { k: 'action', t: `Rejected: ${reason}. No ticket created.` },
    ] });
    setStatus(`${p.id} rejected: ${reason}.`, 'good');
    render(); renderLists();
  }

  // ------------------------------------------------------------ render: result panel
  const STATUS_CHIP = {
    found: '<span class="chip good" title="Read directly from the email">found</span>',
    inferred: '<span class="chip info" title="Worked out from clues in the email. Worth a glance.">inferred</span>',
    review: '<span class="chip warn" title="Not in the email. Fill in or follow up.">needs review</span>',
    edited: '<span class="chip" title="Changed by a person">edited</span>',
  };
  const RULE_ICON = { pass: '✓', warn: '!', fail: '✕' };
  const editable = () => cur && ['shadow', 'person', 'draft'].includes(cur.mode);
  const chipFor = k => (cur.ticket.edited[k] ? STATUS_CHIP.edited : STATUS_CHIP[(cur.meta.fields[k] || {}).status || 'inferred']);

  function fieldRule(k) {
    const map = { customer: ['name'], phone: ['phone'], address: ['address'], zip: ['zip', 'area'], claim: ['claim'], trade: ['trade'], problem: ['problem'] };
    const ids = map[k] || [];
    const rs = cur.ev.rules.filter(r => ids.includes(r.id));
    const bad = rs.find(r => r.status === 'fail') || rs.find(r => r.status === 'warn');
    return { cls: bad ? bad.status : rs.length ? 'pass' : '', msg: bad ? bad.reason : '' };
  }
  function input(k, label, opts = {}) {
    const id = 'f-' + k, t = cur.ticket, val = t[k] || '';
    const ph = opts.placeholder || 'Not found in email';
    const ro = editable() ? '' : 'readonly';
    const ctl = opts.multiline
      ? `<textarea id="${id}" data-k="${k}" rows="1" class="grow" placeholder="${h(ph)}" ${ro}>${h(val)}</textarea>`
      : `<input id="${id}" data-k="${k}" value="${h(val)}" placeholder="${h(ph)}" ${opts.mono ? 'class="mono"' : ''} autocomplete="off" ${ro}>`;
    const fr = fieldRule(k);
    return `<div class="fld ${opts.wide ? 'wide' : ''} v-${fr.cls}" data-fld="${k}">
      <div class="fld-head"><label for="${id}">${label}</label>${chipFor(k)}</div>${ctl}
      <p class="fld-msg" data-msg="${k}">${h(fr.msg)}</p></div>`;
  }
  function select(k, label, options) {
    const id = 'f-' + k, fr = fieldRule(k);
    return `<div class="fld v-${fr.cls}" data-fld="${k}"><div class="fld-head"><label for="${id}">${label}</label>${chipFor(k)}</div>
      <select id="${id}" data-k="${k}" ${editable() ? '' : 'disabled'}>${options.map(([v, t]) => `<option value="${h(v)}" ${v === cur.ticket[k] ? 'selected' : ''}>${h(t)}</option>`).join('')}</select>
      <p class="fld-msg" data-msg="${k}">${h(fr.msg)}</p></div>`;
  }

  function decisionHtml() {
    const { ev, mode } = cur, d = ev.decision;
    const reasons = d.reasons.length ? `<ul class="reasons">${d.reasons.map(r => `<li class="r-${r.code}"><span class="chip ${r.code === 'rule' ? 'bad' : r.code === 'confidence' ? 'warn' : 'bad'}">${h(r.label)}</span> ${h(r.text)}</li>`).join('')}</ul>` : '';
    const steps = d.steps.length ? `<div class="next"><span class="next-k">Suggested next step</span><ol>${d.steps.map(s => `<li>${h(s)}</li>`).join('')}</ol></div>` : '';
    const passLine = `All ${ev.rules.length} checks passed${ev.counts.warn ? ' (' + ev.counts.warn + ' warning)' : ''}. No duplicate, no recent visit.`;
    const tech = techOf(cur.ticket.techId);
    if (mode === 'shadow') {
      return d.route === 'create'
        ? `<div class="decision shadow good"><div class="d-k">Shadow mode · nothing written</div><div class="d-v">Would create ticket <span class="mono">${h(nextTicketNo())}</span></div><p>${passLine}${tech ? ' Would assign ' + h(tech.name) + '.' : ''}</p><p class="small muted">Edit any field to see the checks re-run. Turn shadow mode off to let it act.</p></div>`
        : `<div class="decision shadow warn"><div class="d-k">Shadow mode · nothing written</div><div class="d-v">Would send to a person</div>${reasons}${steps}<p class="small muted">Try fixing a field below: the checks re-run as you type.</p></div>`;
    }
    if (mode === 'created') {
      const q = queue.find(x => x.id === cur.refId);
      return `<div class="decision good"><div class="d-k">Done automatically</div><div class="d-v">Created ticket <span class="mono">${h(cur.refId)}</span></div><p>${passLine}${q ? ' Assigned to ' + h((techOf(q.techId) || {}).name || 'dispatch') + '; first call due ' + h(clock(q.deadline)) + '.' : ''}</p><button type="button" class="btn ghost small" data-goto="tickets">See it in Tickets created</button></div>`;
    }
    if (mode === 'approved') return `<div class="decision good"><div class="d-k">Approved by a person</div><div class="d-v">${h(cur.refId)} → ticket <span class="mono">${h(cur.item.ticketId)}</span></div><button type="button" class="btn ghost small" data-goto="tickets">See it in Tickets created</button></div>`;
    if (mode === 'rejected') return `<div class="decision muted-d"><div class="d-k">Rejected by a person</div><div class="d-v">${h(cur.refId)}: ${h(cur.item.rejectReason)}</div><p class="small">No ticket was created. The email and the decision stay in the activity log.</p></div>`;
    if (mode === 'person') {
      const fails = ev.counts.fail;
      const dup = ev.history.duplicates[0];
      const opts = [dup ? `Duplicate of ${dup.id}: email added to that job` : '', ev.rules.some(r => r.id === 'area' && r.status === 'fail') ? 'Outside the service area' : '', 'Not a work order / spam', 'Customer cancelled'].filter(Boolean);
      return `<div class="decision warn"><div class="d-k">Needs a person · ${h(cur.refId)}</div><div class="d-v">${h(d.reasons.length ? 'Held for review' : 'Ready to approve')}</div>${reasons}${steps}
        ${shadow ? '<p class="small muted">Shadow mode is on, so approving or rejecting is paused. Turn it off to act.</p>' : ''}
        <div class="p-actions">
          <button type="button" class="btn" id="approve" ${!d.canApprove || shadow ? 'disabled' : ''}>${d.canApprove ? (d.reasons.length ? 'Approve & create ticket' : 'Approve & create ticket') : `Fix ${fails} failed check${fails === 1 ? '' : 's'} to approve`}</button>
          <div class="reject">
            <label for="rej-reason" class="sr-only">Reason for rejecting</label>
            <select id="rej-reason" ${shadow ? 'disabled' : ''}>${opts.map(o => `<option>${h(o)}</option>`).join('')}<option value="__other">Other…</option></select>
            <input id="rej-other" placeholder="Reason" hidden>
            <button type="button" class="btn ghost" id="reject" ${shadow ? 'disabled' : ''}>Reject</button>
          </div>
        </div></div>`;
    }
    return '';
  }

  function checksHtml() {
    const { ev } = cur;
    return `<div class="c-h"><b>Checks</b> <span class="chip ${ev.counts.fail ? 'bad' : 'good'}">${ev.counts.pass} pass · ${ev.counts.fail} fail</span></div>
      <ul class="rules">${ev.rules.map(r => `<li class="rule ${r.status}"><span class="r-ic" aria-label="${r.status}">${RULE_ICON[r.status]}</span><span><b>${h(r.label)}</b><span class="r-why">${h(r.reason)}</span></span></li>`).join('')}</ul>`;
  }
  function historyHtml() {
    const hs = cur.ev.history;
    const row = (m, kind) => {
      const tech = techOf(m.techId);
      const when = m.completedAt ? `completed ${dateOf(m.completedAt)}` : m.createdAt ? `opened ${dateOf(m.createdAt)}` : '';
      return `<li class="match ${kind}"><div class="m-top"><span class="mono m-id">${h(m.id)}</span><span class="chip ${kind === 'related' ? '' : 'bad'}">${kind === 'dup' ? 'Duplicate' : kind === 'recall' ? 'Return visit' : 'Other open job'}</span></div>
        <div class="m-issue">${h(m.issue || '')}</div><div class="m-meta muted">${h([m.trade, when, String(m.status).replace('_', ' '), tech ? tech.name : '', m.claim].filter(Boolean).join(' · '))}</div>
        <div class="m-why">${h(m.why)}</div></li>`;
    };
    const items = hs.duplicates.map(m => row(m, 'dup')).concat(hs.recalls.map(m => row(m, 'recall')), hs.related.map(m => row(m, 'related')));
    const cust = hs.customer ? `<p class="small muted">Existing customer: <b>${h(hs.customer.name)}</b> (${h(hs.customer.id)})</p>` : '<p class="small muted">New customer: no match on phone or address.</p>';
    return `<div class="c-h"><b>Duplicate &amp; return-visit check</b> <span class="chip ${hs.duplicates.length || hs.recalls.length ? 'bad' : 'good'}">${hs.duplicates.length || hs.recalls.length ? (hs.duplicates.length + hs.recalls.length) + ' match' : 'clear'}</span></div>
      ${cust}${items.length ? `<ul class="matches">${items.join('')}</ul>` : `<p class="m-none">Checked ${S.jobs.length + queue.length + openPerson().length} jobs, tickets and held emails: same claim, same phone or address with an open job, and the same item fixed in the last 30 days. Nothing matched.</p>`}`;
  }
  function traceHtml() {
    const { ev, cost, meta } = cur;
    const hs = ev.history;
    const steps = [
      ['Received', cur.source && cur.source.kind === 'pdf' ? 'PDF' : 'email'],
      ['Read', meta.engine === 'claude' ? 'Claude' : 'built-in'],
      ['Checked', `${ev.counts.pass}/${ev.rules.length}`, ev.counts.fail ? 'bad' : 'good'],
      ['History', hs.duplicates.length ? 'duplicate' : hs.recalls.length ? 'recall' : 'clear', hs.duplicates.length || hs.recalls.length ? 'bad' : 'good'],
      ['Decision', ev.decision.route === 'create' ? 'ticket' : 'person', ev.decision.route === 'create' ? 'good' : 'warn'],
    ];
    return `<ol class="trace" aria-label="Pipeline">${steps.map(([k, v, c]) => `<li class="${c || ''}"><span>${k}</span><b>${h(v)}</b></li>`).join('')}<li class="cost-step"><span>Cost</span><b class="mono">${money(cost.usd, 4)}</b></li></ol>`;
  }

  function deadlineFor(t) {
    const v = vendorOf(t.vendor);
    let hours = v.firstCallHours;
    const within = (cur.raw.match(/within\s+(\d{1,3})\s*(?:hours|hrs?)\b/i) || [])[1];
    if (within && v.claimPrefix && v.id === cur.meta.fields.vendor.value) hours = Number(within);
    const baseHours = hours;
    if (t.urgency === 'Emergency') hours = Math.min(hours, 1);
    return { hours, baseHours, iso: new Date(new Date(cur.meta.receivedAt).getTime() + hours * 3600000).toISOString(), vendor: v };
  }
  function fmtDeadline(iso, now = Date.now()) {
    const ms = new Date(iso) - now, abs = Math.abs(ms);
    const hrs = Math.floor(abs / 3600000), mins = Math.floor((abs % 3600000) / 60000);
    const span = hrs ? `${hrs}h ${String(mins).padStart(2, '0')}m` : `${mins}m`;
    return ms >= 0 ? { text: span + ' left', cls: ms < 3600000 ? 'bad' : ms < 4 * 3600000 ? 'warn' : 'good' } : { text: span + ' overdue', cls: 'bad' };
  }

  function render() {
    if (!cur) return;
    const t = cur.ticket, v = vendorOf(t.vendor);
    const dl = deadlineFor(t), d = fmtDeadline(dl.iso);
    const load = I.suggestTech(t.trade, S, queueJobs());
    const best = load[0];
    const techOpts = S.techs.map(x => { const l = load.find(y => y.tech.id === x.id); return [x.id, l ? `${x.name} · ${l.jobs} job${l.jobs === 1 ? '' : 's'}` : `${x.name} (${x.trade})`]; });
    const engine = cur.meta.engine === 'claude' ? `<span class="engine claude">Claude · ${h(I.CLAUDE_MODEL)}</span>` : '<span class="engine">Built-in reader · offline</span>';
    const flags = t.flags || [];
    const tno = cur.mode === 'created' ? cur.refId : cur.mode === 'approved' ? cur.item.ticketId : cur.mode === 'person' || cur.mode === 'rejected' ? cur.refId : nextTicketNo();
    const tag = { shadow: 'shadow draft', created: 'created', approved: 'created', person: 'held for review', rejected: 'rejected', draft: 'draft' }[cur.mode];
    const tech = techOf(t.techId) || {};
    els.out.innerHTML = `
      <div class="t-head">
        <div>
          <div class="t-no mono">${h(tno)} <span class="muted">· ${h(tag)}</span></div>
          <h2 class="t-title">${h(t.customer || 'Unknown customer')}</h2>
          <div class="t-sub muted">${h([t.equipmentBase || t.trade, v.name].filter(Boolean).join(' · '))}</div>
        </div>
        <div class="t-badges"><span class="urg ${URG_CLASS[t.urgency] || ''}">${h(t.urgency)}</span>${engine}</div>
      </div>
      ${traceHtml()}
      <div id="decision">${decisionHtml()}</div>
      <div class="checks-grid"><section class="checks" id="checks" aria-label="Validation checks">${checksHtml()}</section><section class="history" id="history" aria-label="Duplicate and return-visit check">${historyHtml()}</section></div>

      <h3 class="sec-h">Ticket fields ${editable() ? '<span class="muted small">edit to fix; checks re-run as you type</span>' : ''}</h3>
      <div class="fields">
        ${input('customer', 'Customer')}
        ${input('phone', 'Phone', { mono: true })}
        ${input('address', 'Service address')}
        ${input('zip', 'ZIP', { mono: true })}
        ${select('vendor', 'Source / vendor', S.vendors.map(x => [x.id, x.name]))}
        ${input('claim', 'Claim #', { mono: true, placeholder: v.claimPrefix ? (I.CLAIM_FORMATS[v.id] || {}).label + ' or "to follow"' : 'Not needed (direct)' })}
        ${select('trade', 'Trade', [['HVAC', 'HVAC'], ['Plumbing', 'Plumbing'], ['Appliance', 'Appliance']].concat(t.trade ? [] : [['', 'Choose…']]))}
        ${select('urgency', 'Urgency', [['Emergency', 'Emergency'], ['High', 'High'], ['Normal', 'Normal']])}
        ${input('equipment', 'Equipment / system', { wide: true, multiline: true })}
        ${input('problem', 'Problem summary', { wide: true, multiline: true })}
      </div>
      ${cur.meta.urgencyReasons && cur.meta.urgencyReasons.length ? `<p class="why muted"><b>Why ${h(cur.meta.fields.urgency.value)}:</b> ${h(cur.meta.urgencyReasons.join(', '))}</p>` : ''}

      <div class="sla ${d.cls}">
        <div><span class="sla-k">First call due</span><span class="sla-v">${h(clock(dl.iso))}</span></div>
        <div><span class="sla-k">Time left</span><span class="sla-v mono" data-countdown="${h(dl.iso)}">${h(d.text)}</span></div>
        <div class="sla-why muted">${h(dl.vendor.short)} rule: ${dl.baseHours} hrs${t.urgency === 'Emergency' ? ' · emergency: 1 hr' : ''}</div>
      </div>
      ${flags.length ? `<div class="flags" role="list" aria-label="Things to act on"><div class="flags-h">Heads up <span class="chip">${flags.length}</span></div>
        ${flags.map(f => `<div class="flag ${f.kind}" role="listitem"><span class="flag-dot" aria-hidden="true"></span><span>${h(f.msg)}</span></div>`).join('')}</div>` : ''}

      <div class="tech">
        <div class="tech-av" style="--c:${h(tech.color || '#888')}" aria-hidden="true">${h(tech.initials || '?')}</div>
        <div class="tech-body">
          <label for="f-techId">Suggested technician</label>
          <select id="f-techId" data-k="techId" ${editable() ? '' : 'disabled'}>${techOpts.map(([val, txt]) => `<option value="${val}" ${val === t.techId ? 'selected' : ''}>${h(txt)}</option>`).join('')}</select>
          <p class="muted small">${best ? `${h(best.tech.name.split(' ')[0])} is the ${h(t.trade)} tech with the lightest load: ${best.jobs} job${best.jobs === 1 ? '' : 's'} (${best.hours} hrs) booked today and tomorrow.` : 'Pick a trade to get a suggestion.'}</p>
        </div>
      </div>
      <div class="sms">
        <div class="sms-head"><label for="f-sms">First-contact text to customer</label><span class="muted small mono" id="sms-count">${t.sms.length} chars · ${Math.ceil(t.sms.length / 160)} SMS</span></div>
        <div class="bubble-wrap"><textarea id="f-sms" data-k="sms" rows="3" class="bubble grow">${h(t.sms)}</textarea></div>
        <div class="row sms-actions"><button type="button" class="btn ghost small" id="copy-sms">Copy text</button><button type="button" class="btn ghost small" id="redraft">Redraft</button><span class="muted small" id="copy-msg" aria-live="polite"></span></div>
      </div>
      <details class="orig"><summary>Original ${cur.source && cur.source.kind === 'pdf' ? 'PDF text' : 'email'}</summary><pre>${h(cur.raw)}</pre></details>`;
    $$('textarea.grow', els.out).forEach(grow);
    renderCost();
  }
  function grow(ta) { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight + 2) + 'px'; }
  window.addEventListener('resize', () => $$('textarea.grow', els.out).forEach(grow));

  // Re-run the checks after an edit without re-rendering the inputs (keeps focus).
  function recheck() {
    cur.ev = evaluateCur();
    $('#decision').innerHTML = decisionHtml();
    $('#checks').innerHTML = checksHtml();
    $('#history').innerHTML = historyHtml();
    $$('[data-fld]', els.out).forEach(el => {
      const fr = fieldRule(el.dataset.fld);
      el.className = el.className.replace(/\bv-\w*/, 'v-' + fr.cls);
      const m = el.querySelector('.fld-msg'); if (m) m.textContent = fr.msg;
    });
    const tr = $('.trace', els.out); if (tr) tr.outerHTML = traceHtml();
  }

  els.out.addEventListener('input', e => {
    const k = e.target.dataset.k;
    if (!k || !cur || e.target.tagName === 'SELECT') return;
    cur.ticket[k] = e.target.value;
    if (e.target.classList.contains('grow')) grow(e.target);
    if (k === 'sms') { const n = cur.ticket.sms.length; $('#sms-count').textContent = `${n} chars · ${Math.ceil(n / 160)} SMS`; return; }
    if (!editable()) return;
    cur.ticket.edited[k] = true;
    const chip = e.target.closest('.fld').querySelector('.chip');
    if (chip) chip.outerHTML = STATUS_CHIP.edited;
    if (k === 'customer' || k === 'claim') { cur.ticket.sms = I.draftText(cur.ticket, S); $('#f-sms').value = cur.ticket.sms; grow($('#f-sms')); }
    recheck();
  });
  els.out.addEventListener('change', e => {
    if (e.target.id === 'rej-reason') { const o = $('#rej-other'); o.hidden = e.target.value !== '__other'; if (!o.hidden) o.focus(); return; }
    const k = e.target.dataset.k;
    if (!k || !cur || e.target.tagName !== 'SELECT' || !editable()) return;
    cur.ticket[k] = e.target.value;
    if (k === 'trade') { const best = I.suggestTech(cur.ticket.trade, S, queueJobs())[0]; if (best) cur.ticket.techId = best.tech.id; }
    if (k !== 'techId') cur.ticket.edited[k] = true;
    cur.ticket.sms = I.draftText(cur.ticket, S);
    cur.ev = evaluateCur();
    const focusId = e.target.id;
    render();
    const el = document.getElementById(focusId); if (el) el.focus();
  });
  els.out.addEventListener('click', e => {
    const id = e.target.id;
    if (id === 'copy-sms') copy(cur.ticket.sms);
    if (id === 'redraft') { cur.ticket.sms = I.draftText(cur.ticket, S); $('#f-sms').value = cur.ticket.sms; $('#f-sms').dispatchEvent(new Event('input', { bubbles: true })); }
    if (id === 'approve') approve();
    if (id === 'reject') { const sel = $('#rej-reason'); reject(sel.value === '__other' ? $('#rej-other').value : sel.value); }
    const g = e.target.closest('[data-goto]'); if (g) { showTab(g.dataset.goto); $('#lists').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });
  async function copy(text) {
    const msg = $('#copy-msg');
    try { await navigator.clipboard.writeText(text); msg.textContent = 'Copied.'; }
    catch (err) { const ta = $('#f-sms'); ta.focus(); ta.select(); try { document.execCommand('copy'); msg.textContent = 'Copied.'; } catch (e2) { msg.textContent = 'Press Ctrl/Cmd+C to copy.'; } }
    setTimeout(() => { msg.textContent = ''; }, 2200);
  }

  // ------------------------------------------------------------ cost meter
  function renderCost() {
    const runs = log.filter(e => e.kind === 'run');
    const total = runs.reduce((s, e) => s + (e.cost || 0), 0);
    const claudeRuns = runs.filter(e => e.engine === 'claude' && e.cost);
    const perClaude = claudeRuns.length ? claudeRuns.reduce((s, e) => s + e.cost, 0) / claudeRuns.length
      : runs.length ? runs.reduce((s, e) => s + (e.est || 0), 0) / runs.length : (cur ? cur.est.usd : 0.0075);
    const thisOne = cur ? cur.cost.usd : 0;
    const P = I.PRICING;
    els.cost.innerHTML = `
      <div class="c-cell"><span class="c-k">This email</span><b class="mono">${money(thisOne)}</b><span class="c-s">${cur && cur.meta.engine === 'claude' ? 'Claude, ' + h(cur.cost.basis) : 'built-in reader'}</span></div>
      <div class="c-cell"><span class="c-k">Running total</span><b class="mono">${money(total)}</b><span class="c-s">${runs.length} run${runs.length === 1 ? '' : 's'}</span></div>
      <div class="c-cell"><span class="c-k">At ${MONTHLY} emails / month</span><b class="mono">$0.00 <span class="c-or">or</span> ≈ ${money(perClaude * MONTHLY, 2)}</b><span class="c-s">built-in, or with Claude (${claudeRuns.length ? 'your average' : '≈ ' + money(perClaude, 4) + ' each'})</span></div>
      <p class="c-note small muted">Claude cost is an estimate at assumed prices of $${P.inputPerMTok} / $${P.outputPerMTok} per million input / output tokens for ${h(P.model)} (${h(P.asOf)}). Check current pricing.</p>`;
  }

  // ------------------------------------------------------------ render: lists
  function renderLists() {
    const open = openPerson();
    els.nT.textContent = queue.length; els.nP.textContent = open.length; els.nL.textContent = log.length;
    els.nP.className = 'chip' + (open.length ? ' warn' : '');
    els.qclear.hidden = !queue.length; els.pclear.hidden = !person.length; els.lclear.hidden = !log.length;
    renderQueue(); renderPerson(); renderLog(); renderCost();
  }

  function renderQueue() {
    if (!queue.length) {
      els.queue.innerHTML = `<div class="q-empty muted">${shadow ? 'Shadow mode is on, so nothing is created yet: the activity log shows what <i>would</i> have been. Turn shadow mode off to let it create tickets.' : 'No tickets yet. Process a clean email from the inbox and it lands here.'}</div>`;
      return;
    }
    const now = Date.now();
    els.queue.innerHTML = queue.map(q => {
      const t = techOf(q.techId), v = vendorOf(q.vendor), d = fmtDeadline(q.deadline, now);
      const due = q.calledAt ? `<span class="chip good">Called ${h(new Date(q.calledAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}</span>` : `<span class="chip ${d.cls} mono" data-countdown="${h(q.deadline)}">${h(d.text)}</span>`;
      return `<article class="q-row" data-row="${h(q.id)}">
        <div class="q-id mono">${h(q.id)}</div>
        <div class="q-main"><div class="q-name">${h(q.customer || 'Unknown customer')} <span class="urg sm ${URG_CLASS[q.urgency] || ''}">${h(q.urgency)}</span></div>
          <div class="q-meta muted">${h([q.trade, q.equipment ? q.equipment.split(/[,(]/)[0].trim() : '', q.address].filter(Boolean).join(' · '))}</div>
          <div class="q-meta muted">${h(v.short || '')}${q.claim ? ' · <span class="mono">' + h(q.claim) + '</span>' : v.claimPrefix ? ' · <span class="chip warn">claim # to follow</span>' : ''}</div></div>
        <div class="q-tech">${t ? `<span class="tech-av sm" style="--c:${h(t.color)}" aria-hidden="true">${h(t.initials)}</span><span class="q-tname">${h(t.name)}</span>` : '<span class="muted">Unassigned</span>'}</div>
        <div class="q-due"><span class="q-due-k muted">First call</span>${due}</div>
        <div class="q-act">${q.calledAt ? '' : `<button type="button" class="btn ghost small" data-call="${h(q.id)}">Mark called</button>`}</div>
      </article>`;
    }).join('');
  }

  function renderPerson() {
    const open = openPerson(), done = person.filter(p => p.status !== 'open');
    let html = '';
    if (!open.length) {
      html += `<div class="q-empty muted">${shadow ? 'Shadow mode is on, so nothing is sent here yet. The activity log shows what <i>would</i> have come here. Turn shadow mode off, then try the duplicate or out-of-area sample.' : 'Nothing waiting. Emails that fail a check, look like a duplicate or return visit, are emergencies or were read with low confidence land here.'}</div>`;
    }
    html += open.map(p => {
      const t = p.ticket, fails = (p.rules || []).filter(r => r.status === 'fail');
      const hs = p.history || { duplicates: [], recalls: [] };
      const matches = hs.duplicates.map(m => ['Duplicate', m]).concat(hs.recalls.map(m => ['Return visit', m]));
      return `<article class="p-card" data-p="${h(p.id)}">
        <div class="p-top"><span class="mono p-id">${h(p.id)}</span><span class="p-subj">${h(p.subject || '(no subject)')}</span><span class="muted small">${h(timeOf(p.receivedAt))}</span></div>
        <div class="p-why">${p.reasons.map(r => `<span class="chip ${r.code === 'confidence' ? 'warn' : 'bad'}">${h(r.label)}</span>`).filter((x, i, a) => a.indexOf(x) === i).join(' ')}</div>
        <div class="p-grid">
          <div><div class="p-k">What it read</div><dl class="p-dl">
            ${[['Customer', t.customer], ['Phone', t.phone], ['Address', [t.address, t.zip].filter(Boolean).join(', ')], ['Vendor', vendorOf(t.vendor).short + (t.claim ? ' · ' + t.claim : '')], ['Trade', t.trade], ['Problem', t.problem]].map(([k, v]) => `<dt>${k}</dt><dd>${h(v || '—')}</dd>`).join('')}
          </dl></div>
          <div><div class="p-k">Why it is here</div><ul class="p-list">
            ${fails.map(r => `<li><b>${h(r.label)}:</b> ${h(r.reason)}</li>`).join('')}
            ${matches.map(([k, m]) => `<li><b>${k} ${h(m.id)}</b> (${h(m.issue)}, ${h(m.completedAt ? 'completed ' + dateOf(m.completedAt) : 'opened ' + dateOf(m.createdAt))}): ${h(m.why)}</li>`).join('')}
            ${p.reasons.filter(r => r.code === 'emergency' || r.code === 'confidence').map(r => `<li>${h(r.text)}</li>`).join('')}
          </ul>
          <div class="p-k">Suggested next step</div><p class="p-next">${h(p.steps[0] || 'Check the email and decide.')}</p></div>
        </div>
        <details class="orig"><summary>Original ${p.source && p.source.kind === 'pdf' ? 'PDF text' : 'email'}</summary><pre>${h(p.raw)}</pre></details>
        <div class="row p-btns"><button type="button" class="btn small" data-review="${h(p.id)}">Review, fix &amp; approve</button><button type="button" class="btn ghost small" data-review="${h(p.id)}">Reject…</button></div>
      </article>`;
    }).join('');
    if (done.length) {
      html += `<div class="p-done"><div class="p-k">Handled (${done.length})</div><ul>${done.map(p => `<li><span class="mono">${h(p.id)}</span> ${h(p.subject || '')} <span class="muted">·</span> ${p.status === 'approved' ? `<span class="chip good">Approved → ${h(p.ticketId)}</span>` : `<span class="chip">Rejected: ${h(p.rejectReason)}</span>`} <span class="muted small">${h(timeOf(p.resolvedAt))}</span></li>`).join('')}</ul></div>`;
    }
    els.person.innerHTML = html;
  }

  const STEP_LABEL = { received: 'Received', extracted: 'Read', validated: 'Checked', checked: 'History', decision: 'Decision', action: 'Action', person: 'Person' };
  function renderLog() {
    const runs = log.filter(e => e.kind === 'run');
    els.logSum.textContent = log.length ? `${runs.length} run${runs.length === 1 ? '' : 's'} · ${runs.filter(e => e.shadow).length} in shadow mode · total cost ${money(runs.reduce((s, e) => s + (e.cost || 0), 0))}. Newest first. Saved in this browser.` : 'Every run, newest first: received → read → checked → duplicate check → decision → action.';
    if (!log.length) { els.log.innerHTML = '<li class="q-empty muted">Nothing logged yet.</li>'; return; }
    els.log.innerHTML = log.map((e, i) => {
      const badge = e.kind === 'run' ? (e.shadow ? '<span class="chip shadow-chip">shadow</span>' : '<span class="chip good">live</span>') : e.kind === 'person' ? '<span class="chip info">person</span>' : `<span class="chip ${e.warn ? 'bad' : ''}">system</span>`;
      const cls = e.kind === 'run' ? (e.route === 'create' ? 'ok' : 'hold') : e.kind;
      const steps = (e.steps || []).length ? `<details ${i === 0 ? 'open' : ''}><summary>${e.steps.length} steps</summary><ol class="steps-l">${e.steps.map(s => `<li><span class="s-k">${h(STEP_LABEL[s.k] || s.k)}</span><span>${h(s.t)}</span></li>`).join('')}</ol></details>` : '';
      return `<li class="log-e ${cls}"><div class="l-top"><time class="mono" datetime="${h(e.at)}">${h(timeOf(e.at))}</time>${badge}${e.kind === 'run' ? `<span class="mono l-cost">${money(e.cost)}</span>` : ''}</div>
        <div class="l-title">${h(e.title)}</div>${steps}</li>`;
    }).join('');
  }

  els.queue.addEventListener('click', e => {
    const c = e.target.closest('[data-call]');
    if (!c) return;
    const q = queue.find(x => x.id === c.dataset.call);
    if (q) { q.calledAt = new Date().toISOString(); addLog({ kind: 'person', title: `First call made on ${q.id}`, steps: [] }); }
    save(); renderLists();
  });
  els.person.addEventListener('click', e => {
    const b = e.target.closest('[data-review]');
    if (!b) return;
    reviewItem(b.dataset.review);
    if (/Reject/.test(b.textContent)) setTimeout(() => { const r = $('#rej-reason'); if (r) r.focus(); }, 400);
  });
  els.qclear.addEventListener('click', () => { if (!confirm('Clear all demo tickets from this browser?')) return; queue = []; save(); addLog({ kind: 'system', title: 'Demo tickets cleared by the user', steps: [] }); if (cur && cur.mode === 'created') cur.mode = 'draft'; render(); });
  els.pclear.addEventListener('click', () => {
    if (!confirm('Clear all Needs-a-person demo items from this browser?')) return;
    person = []; save();
    addLog({ kind: 'system', title: 'Needs-a-person demo items cleared by the user', steps: [] });
    if (cur && cur.refId && /^IN-/.test(cur.refId)) { cur = null; els.out.innerHTML = '<div class="t-empty muted"><p><b>Pick an email from the inbox</b> to see it read, checked and routed.</p></div>'; renderCost(); }
    else render();
  });
  els.lclear.addEventListener('click', () => { if (!confirm('Clear the activity log in this browser?')) return; log = []; save(); renderLists(); });

  // ------------------------------------------------------------ tabs
  const TABS = ['tickets', 'person', 'log'];
  function showTab(name) {
    if (!TABS.includes(name)) name = 'tickets';
    TABS.forEach(t => {
      const tab = $('#tab-' + t), pane = $('#pane-' + t), on = t === name;
      tab.setAttribute('aria-selected', on); tab.tabIndex = on ? 0 : -1; pane.hidden = !on;
    });
    store.set(K.tab, name);
  }
  $('.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
  $('.tabs').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const i = TABS.indexOf(store.get(K.tab, 'tickets'));
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    showTab(TABS[n]); $('#tab-' + TABS[n]).focus(); e.preventDefault();
  });

  // ------------------------------------------------------------ keyboard + timers
  els.create.addEventListener('click', run);
  els.email.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(); });
  setInterval(() => {
    const now = Date.now();
    $$('[data-countdown]').forEach(el => { const d = fmtDeadline(el.dataset.countdown, now); el.textContent = d.text; if (el.classList.contains('chip')) el.className = 'chip mono ' + d.cls; });
  }, 30000);

  // ------------------------------------------------------------ start
  if (firstVisit) store.set(K.shadow, 'on');
  syncShadow();
  showTab(store.get(K.tab, 'tickets'));
  renderLists();
  loadSample(0);
  if (firstVisit || !log.length) run(); // first visit: one shadow-mode run so the page shows a result
  else setStatus('Pick an email from the inbox, or press Process email.', '');
})();
