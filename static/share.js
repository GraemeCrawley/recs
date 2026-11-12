// Text for passing a suggestion on to someone ("Share" in the item sheet). Pure, tested by tests/share.test.js.
// Deliberately leaves out who suggested it and your notes: those stay private.
(function (root) {
  const ICON = { book: "📕", movie: "🎬", show: "📺", restaurant: "🍽️", place: "📍", podcast: "🎧", music: "🎵", game: "🎮", other: "✳️" };
  const KIND = { book: "book", movie: "movie", show: "show", podcast: "podcast", music: "music", game: "game" };

  function shareText(it) {
    const icon = ICON[it.type] || ICON.other;
    const lines = [];
    if (it.lat != null && it.lon != null) {
      const label = it.place_label && it.place_label !== "Pinned where I was" ? it.place_label : "";
      // the address usually repeats the name first ("VSP, Dundas Street West, Toronto"): don't say it twice
      const addr = label.split(", ").filter((part, i) => !(i === 0 && part.toLowerCase() === it.title.toLowerCase())).join(", ");
      lines.push(`${icon} ${it.title}`);
      if (addr) lines.push(addr);
      const q = label ? `${it.title}, ${addr}` : `${it.lat},${it.lon}`;
      lines.push("https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q));
    } else {
      lines.push(`${icon} ${it.title}${it.creator ? ` by ${it.creator}` : ""}${KIND[it.type] ? ` (${KIND[it.type]})` : ""}`);
    }
    return { title: it.title, text: "You should try this:\n" + lines.join("\n") };
  }

  const api = { shareText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RecsShare = api;
})(typeof window !== "undefined" ? window : globalThis);
