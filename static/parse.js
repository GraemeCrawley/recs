// Quick-add parser: "Red Rising Book Jordan L" -> {title:"Red Rising", type:"book", person: Jordan Lewis}.
// Pure function, runs on every keystroke. Loaded as a plain <script> (window.RecsParse)
// and by node tests (module.exports).
(function (root) {
  const TYPES = {
    book: ["book", "books", "novel", "audiobook"],
    movie: ["movie", "movies", "film", "flick"],
    show: ["show", "tv", "series"],
    restaurant: ["restaurant", "resto", "food", "cafe", "café", "bar", "brunch"],
    place: ["place", "visit", "trip", "park", "museum", "travel"],
    podcast: ["podcast", "pod"],
    music: ["music", "album", "song", "band", "artist"],
    game: ["game", "boardgame"],
  };
  const TYPE_OF = {};
  for (const [t, words] of Object.entries(TYPES)) for (const w of words) TYPE_OF[w] = t;

  const norm = (s) => s.toLowerCase().replace(/[.:,]+$/, "");
  const typeWord = (tok) => (tok === undefined ? null : TYPE_OF[norm(tok)] || null);

  // Does the typed fragment q (array of tokens) name this person?
  // "Jordan L" / "Jor" / "J Lewis" -> each token is a prefix of the matching name token.
  // A single token of 3+ letters may also match a later name ("Lewis").
  function score(q, person) {
    const p = person.name.split(/\s+/).map(norm);
    const qs = q.map(norm).filter(Boolean);
    if (!qs.length || qs.length > p.length) return 0;
    if (qs.every((t, i) => p[i].startsWith(t))) {
      // exact whole-token matches beat prefixes
      return 10 * qs.length + qs.filter((t, i) => p[i] === t).length;
    }
    if (qs.length === 1 && qs[0].length >= 3 && p.slice(1).some((n) => n.startsWith(qs[0]))) return 5;
    return 0;
  }

  // people ordered most-recently-used first; that order breaks ties.
  function matchPeople(q, people) {
    return people
      .map((p, i) => ({ p, s: score(q, p), i }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.p);
  }

  const titleCase = (toks) => toks.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" ");

  function parse(text, people) {
    people = people || [];
    let toks = (text || "").trim().split(/\s+/).filter(Boolean);
    let type = null, person = null, candidates = [], newPerson = null;

    const peelTrailingType = () => {
      if (!type && toks.length > 1 && typeWord(toks[toks.length - 1])) type = typeWord(toks.pop());
    };

    // 1. explicit "@name" (or "from name"): everything after it is the person.
    let at = toks.findIndex((t) => t.startsWith("@"));
    let fromIdx = at < 0 ? toks.map(norm).lastIndexOf("from") : -1;
    if (at >= 0 || fromIdx > 0) {
      const start = at >= 0 ? at : fromIdx + 1;
      let rest = toks.slice(start);
      if (at >= 0) rest[0] = rest[0].slice(1);
      rest = rest.filter(Boolean);
      if (rest.length > 1 && typeWord(rest[rest.length - 1])) type = typeWord(rest.pop());
      const hits = matchPeople(rest, people);
      // "from" is also a title word ("Letters from Iwo Jima"): only trust it when it
      // names someone we already know. New people come from "@Name" or the picker.
      if (hits.length || at >= 0) {
        if (hits.length) { person = hits[0]; candidates = hits; }
        else if (rest.length) newPerson = titleCase(rest);
        toks = toks.slice(0, at >= 0 ? at : fromIdx);
      } else {
        type = null;
      }
    }

    // 2. otherwise a known person at the end: try the last 3, 2, 1 words.
    if (!person && !newPerson) {
      peelTrailingType();
      for (let k = Math.min(3, toks.length - 1); k >= 1; k--) {
        const hits = matchPeople(toks.slice(-k), people);
        if (hits.length) { person = hits[0]; candidates = hits; toks = toks.slice(0, -k); break; }
      }
    }

    // 3. type word at the end, or at the start ("book Red Rising", "Book: Red Rising").
    peelTrailingType();
    if (!type && toks.length > 1 && typeWord(toks[0])) type = typeWord(toks.shift());

    const title = toks.join(" ").replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, "");
    return { title, type, person, candidates, newPerson };
  }

  const api = { parse, matchPeople, TYPES: Object.keys(TYPES) };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RecsParse = api;
})(this);
