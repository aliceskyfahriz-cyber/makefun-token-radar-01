(function () {
  var data = window.TOKEN_RADAR || { as_of: "", rows: [] };
  var rows = data.rows || [];

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function fmtUsd(v) {
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
    return "$" + Math.round(v);
  }
  function fmtPct(x) {
    var s = (x >= 0 ? "+" : "") + x.toFixed(2) + "%";
    var cls = x > 0.005 ? "up" : x < -0.005 ? "down" : "flat";
    return '<span class="' + cls + '">' + s + "</span>";
  }
  function chainsText(chains) {
    if (!chains || chains.length === 0) return "—";
    if (chains.length <= 3) return esc(chains.join(", "));
    return esc(chains.slice(0, 3).join(", ")) + " +" + (chains.length - 3);
  }

  var qEl = document.getElementById("q");
  var catEl = document.getElementById("cat");
  var watchEl = document.getElementById("watch");
  var countEl = document.getElementById("count");
  var rowsEl = document.getElementById("rows");
  var detailEl = document.getElementById("detail");

  // Meta + stats.
  var asOf = (data.as_of || "").slice(0, 10);
  var watchCount = rows.filter(function (r) { return r.watchlist; }).length;
  var top = rows.length ? rows[0].implied_value_usd : 0;
  document.getElementById("meta").innerHTML =
    "<b>" + rows.length + "</b> protocols &nbsp;·&nbsp; <b>" + watchCount + "</b> watchlist<br>Snapshot " + esc(asOf);
  document.getElementById("stats").innerHTML =
    '<div class="stat"><div class="k">Board size</div><div class="v">' + rows.length + ' <span class="unit">protocols</span></div></div>' +
    '<div class="stat"><div class="k">Watchlist covered</div><div class="v">' + watchCount + ' <span class="unit">of 40</span></div></div>' +
    '<div class="stat"><div class="k">Top implied value</div><div class="v">' + fmtUsd(top) + '</div></div>' +
    '<div class="stat"><div class="k">Snapshot</div><div class="v" style="font-size:17px;padding-top:4px">' + esc(asOf) + '</div></div>';

  // Category options.
  var cats = [];
  rows.forEach(function (r) { if (cats.indexOf(r.category) < 0) cats.push(r.category); });
  cats.sort();
  cats.forEach(function (c) {
    var o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    catEl.appendChild(o);
  });

  var selected = null;

  function filtered() {
    var q = qEl.value.trim().toLowerCase();
    var cat = catEl.value;
    var watch = watchEl.checked;
    return rows.filter(function (r) {
      if (watch && !r.watchlist) return false;
      if (cat && r.category !== cat) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  function render() {
    var list = filtered();
    var html = "";
    list.forEach(function (r) {
      html += '<tr data-slug="' + esc(r.slug) + '"' + (selected === r.slug ? ' class="sel"' : "") + ">" +
        '<td class="num">' + r.rank + "</td>" +
        '<td><span class="name">' + esc(r.name) + "</span> " +
        (r.watchlist ? '<span class="star" title="Watchlist">★</span> ' : "") +
        '<span class="slug">' + esc(r.slug) + "</span></td>" +
        "<td>" + esc(r.category) + "</td>" +
        "<td>" + chainsText(r.chains) + "</td>" +
        '<td class="num">' + fmtUsd(r.tvl) + "</td>" +
        '<td class="num">' + fmtPct(r.change_1d_pct) + "</td>" +
        '<td class="num">' + fmtPct(r.change_7d_pct) + "</td>" +
        '<td class="num">' + fmtPct(r.change_30d_pct) + "</td>" +
        '<td class="num"><b>' + fmtUsd(r.implied_value_usd) + "</b></td></tr>";
    });
    rowsEl.innerHTML = html;
    countEl.textContent = "Showing " + list.length + " of " + rows.length;
    rowsEl.querySelectorAll("tr").forEach(function (tr) {
      tr.addEventListener("click", function () { showDetail(tr.getAttribute("data-slug")); });
    });
  }

  function showDetail(slug) {
    var r = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].slug === slug) { r = rows[i]; break; }
    if (!r) return;
    selected = slug;
    var steps = (r.farm_steps || []).map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("");
    detailEl.innerHTML =
      '<button class="close" id="dclose">Close</button>' +
      "<h2>" + esc(r.name) + ' <span class="star">' + (r.watchlist ? "★ Watchlist" : "") + "</span></h2>" +
      '<p class="dsub">Rank #' + r.rank + " · " + esc(r.slug) + " · " + esc(r.category) + "</p>" +
      '<div class="grid">' +
      "<div><div class=\"k\">Implied value</div><div class=\"v\">" + fmtUsd(r.implied_value_usd) + "</div></div>" +
      "<div><div class=\"k\">TVL</div><div class=\"v\">" + fmtUsd(r.tvl) + "</div></div>" +
      "<div><div class=\"k\">1d / 7d / 30d</div><div class=\"v\">" + fmtPct(r.change_1d_pct) + " / " + fmtPct(r.change_7d_pct) + " / " + fmtPct(r.change_30d_pct) + "</div></div>" +
      "<div><div class=\"k\">Chains</div><div class=\"v\">" + esc((r.chains || []).join(", ")) + "</div></div>" +
      "</div>" +
      "<h3>How to farm it</h3><ol>" + steps + "</ol>";
    detailEl.hidden = false;
    document.getElementById("dclose").addEventListener("click", function () {
      detailEl.hidden = true;
      selected = null;
      render();
    });
    render();
  }

  qEl.addEventListener("input", render);
  catEl.addEventListener("change", render);
  watchEl.addEventListener("change", render);

  // Deep links for the three views: #detail=<slug>, #filter=watchlist, #filter=<category>.
  var hash = (location.hash || "").slice(1);
  var detailSlug = null;
  if (hash) {
    var parts = hash.split("=");
    if (parts[0] === "filter" && parts[1] === "watchlist") watchEl.checked = true;
    else if (parts[0] === "filter" && parts[1]) catEl.value = decodeURIComponent(parts[1]);
    else if (parts[0] === "detail" && parts[1]) detailSlug = decodeURIComponent(parts[1]);
  }
  render();
  if (detailSlug) showDetail(detailSlug);
})();
