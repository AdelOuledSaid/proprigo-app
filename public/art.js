/* Proprigo : illustrations originales (SVG), sans image externe. */
(() => {
  'use strict';
  // étoile à quatre branches, la « brillance » Proprigo
  const star = (x, y, r, fill, cls = '') => `<path class="${cls}" fill="${fill}" d="M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z"/>`;
  const railing = (x, y, w) => {
    let s = `<rect x="${x}" y="${y}" width="${w}" height="5" rx="2.5" fill="#0f1a4a"/><rect x="${x}" y="${y + 34}" width="${w}" height="4" rx="2" fill="#0f1a4a"/>`;
    for (let i = x + 8; i < x + w - 4; i += 14) s += `<line x1="${i}" y1="${y + 5}" x2="${i}" y2="${y + 34}" stroke="#0f1a4a" stroke-width="2.5"/><circle cx="${i + 7}" cy="${y + 20}" r="5" fill="none" stroke="#0f1a4a" stroke-width="2"/>`;
    return s;
  };
  const plant = (x, y) => `<path d="M${x - 12} ${y}h24l-4 18h-16z" fill="#ff6a3d"/><ellipse cx="${x - 7}" cy="${y - 9}" rx="6" ry="11" transform="rotate(-25 ${x - 7} ${y - 9})" fill="#18b98a"/><ellipse cx="${x + 7}" cy="${y - 10}" rx="6" ry="12" transform="rotate(22 ${x + 7} ${y - 10})" fill="#13a079"/><ellipse cx="${x}" cy="${y - 15}" rx="5" ry="12" fill="#22c896"/>`;

  // Façade parisienne. clean=false : façade ternie (avant) ; clean=true : tout brille (après).
  const win = (x, clean) => clean
    ? `<rect x="${x}" y="82" width="86" height="148" rx="6" fill="#bcd2ff"/><path d="M${x} 82h86v148h-86z" fill="url(#shine)"/>
       <path d="M${x + 12} 210l34-112h14l-34 112z" fill="#fff" opacity=".75"/><path d="M${x + 36} 214l26-86h8l-26 86z" fill="#fff" opacity=".55"/>
       <rect x="${x}" y="82" width="86" height="148" rx="6" fill="none" stroke="#1f4fff" stroke-width="6"/>
       <line x1="${x + 43}" y1="82" x2="${x + 43}" y2="230" stroke="#1f4fff" stroke-width="5"/><line x1="${x}" y1="152" x2="${x + 86}" y2="152" stroke="#1f4fff" stroke-width="5"/>`
    : `<rect x="${x}" y="82" width="86" height="148" rx="6" fill="#d6d6cf"/><path d="M${x} 88q43-14 86 0" fill="none" stroke="#c2c1b8" stroke-width="3"/>
       <circle cx="${x + 22}" cy="120" r="7" fill="#c4c3ba"/><circle cx="${x + 62}" cy="168" r="9" fill="#c4c3ba"/><circle cx="${x + 32}" cy="196" r="5" fill="#c4c3ba"/><circle cx="${x + 70}" cy="110" r="4" fill="#c4c3ba"/>
       <path d="M${x + 8} 140q10 8 4 20M${x + 60} 96q6 10-2 18" stroke="#b9b8ae" stroke-width="3" fill="none"/>
       <rect x="${x}" y="82" width="86" height="148" rx="6" fill="none" stroke="#8a8f9e" stroke-width="6"/>
       <line x1="${x + 43}" y1="82" x2="${x + 43}" y2="230" stroke="#8a8f9e" stroke-width="5"/><line x1="${x}" y1="152" x2="${x + 86}" y2="152" stroke="#8a8f9e" stroke-width="5"/>`;
  const droop = (x, y) => `<path d="M${x - 12} ${y}h24l-4 18h-16z" fill="#b98a74"/><path d="M${x - 2} ${y}q-8-10-14-4M${x + 2} ${y}q8-12 14-6M${x} ${y}q0-12 -4-16" stroke="#9c9a6a" stroke-width="3" fill="none" stroke-linecap="round"/>`;
  const facade = (clean, label) => `<svg class="art-hero" viewBox="0 0 440 390" role="img" aria-label="${label}">
    <defs><linearGradient id="shine" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e7f0ff"/><stop offset="1" stop-color="#9fbcff"/></linearGradient></defs>
    <path d="M58 118C76 46 170 14 252 26c92 13 160 74 168 160 9 98-58 178-160 192-112 15-224-34-244-122-9-40 30-90 42-138z" fill="${clean ? '#e3ebff' : '#e9e7e1'}"/>
    <rect x="92" y="52" width="256" height="318" fill="${clean ? '#ffffff' : '#ece9e1'}"/>
    <rect x="84" y="40" width="272" height="16" rx="4" fill="${clean ? '#c7d4ff' : '#cfccc2'}"/>
    ${[96, 136, 176, 216, 256, 296, 336].map((y) => `<line x1="92" y1="${y}" x2="348" y2="${y}" stroke="${clean ? '#e6ebf8' : '#dcd8cd'}" stroke-width="2"/>`).join('')}
    ${clean ? '' : '<path d="M120 270q8 30 2 60M320 60q-6 40 4 70M200 300q30 10 40 40" stroke="#d8d3c4" stroke-width="10" fill="none" opacity=".7" stroke-linecap="round"/>'}
    ${win(114, clean)}${win(240, clean)}
    ${railing(104, 232, 106)}${railing(230, 232, 106)}
    ${clean ? plant(130, 226) + plant(184, 226) : droop(130, 226) + droop(184, 226)}
    ${clean ? '<g><rect x="302" y="204" width="20" height="26" rx="5" fill="#1f4fff"/><rect x="306" y="194" width="12" height="11" rx="2" fill="#0f1a4a"/><path d="M318 196h12v5h-12z" fill="#0f1a4a"/><rect x="306" y="212" width="12" height="8" rx="2" fill="#fff" opacity=".85"/></g>' : ''}
    <path d="M188 370v-58a32 32 0 0 1 64 0v58z" fill="${clean ? '#1f4fff' : '#6b7391'}"/><line x1="220" y1="286" x2="220" y2="370" stroke="${clean ? '#163bc4' : '#59607b'}" stroke-width="3"/><circle cx="212" cy="334" r="3" fill="#ffc94d"/><circle cx="228" cy="334" r="3" fill="#ffc94d"/>
    <rect x="40" y="366" width="360" height="8" rx="4" fill="${clean ? '#c7d4ff' : '#d4d0c5'}"/>
    ${clean ? `${star(352, 96, 22, '#ff6a3d', 'twinkle t1')}${star(334, 150, 11, '#ffc94d', 'twinkle t2')}${star(226, 72, 9, '#ff6a3d', 'twinkle t3')}${star(372, 196, 8, '#1f4fff', 'twinkle t2')}${star(96, 190, 10, '#ffc94d', 'twinkle t1')}${star(150, 64, 8, '#1f4fff', 'twinkle t3')}
      <circle cx="384" cy="70" r="10" fill="none" stroke="#b9cbff" stroke-width="3"/><circle cx="404" cy="98" r="5" fill="#b9cbff"/><circle cx="40" cy="250" r="7" fill="none" stroke="#b9cbff" stroke-width="3"/>` : ''}
  </svg>`;
  const hero = facade(true, 'Façade d\'immeuble parisien qui brille après le ménage');

  // petites illustrations des prestations
  const services = {
    menage: `<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="8" y="30" width="48" height="18" rx="7" fill="#1f4fff"/><rect x="14" y="22" width="36" height="14" rx="6" fill="#5b80ff"/><rect x="5" y="30" width="10" height="16" rx="5" fill="#163bc4"/><rect x="49" y="30" width="10" height="16" rx="5" fill="#163bc4"/><rect x="12" y="48" width="4" height="7" rx="2" fill="#0f1a4a"/><rect x="48" y="48" width="4" height="7" rx="2" fill="#0f1a4a"/>${star(50, 12, 8, '#ff6a3d')}</svg>`,
    airbnb: `<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="12" y="20" width="40" height="34" rx="7" fill="#ff6a3d"/><path d="M24 20v-6a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v6" fill="none" stroke="#0f1a4a" stroke-width="4"/><rect x="12" y="32" width="40" height="5" fill="#e2552b"/><circle cx="44" cy="46" r="7" fill="#ffc94d"/><rect x="41" y="44" width="16" height="4" rx="2" fill="#ffc94d"/>${star(14, 12, 7, '#1f4fff')}</svg>`,
    grand: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M14 26h36l-5 28H19z" fill="#18b98a"/><rect x="11" y="22" width="42" height="7" rx="3.5" fill="#13a079"/><path d="M18 24a14 14 0 0 1 28 0" fill="none" stroke="#0f1a4a" stroke-width="3"/><circle cx="24" cy="16" r="6" fill="#dbe6ff" stroke="#1f4fff" stroke-width="2"/><circle cx="36" cy="11" r="4" fill="#dbe6ff" stroke="#1f4fff" stroke-width="2"/><circle cx="44" cy="17" r="3" fill="#dbe6ff" stroke="#1f4fff" stroke-width="2"/>${star(54, 40, 7, '#ff6a3d')}</svg>`,
  };

  // aucun ménage prévu : un seau qui attend
  const empty = `<svg class="art-empty" viewBox="0 0 160 120" aria-hidden="true"><ellipse cx="80" cy="108" rx="54" ry="7" fill="#dfe7ff"/><path d="M50 50h60l-8 56H58z" fill="#1f4fff"/><rect x="45" y="44" width="70" height="10" rx="5" fill="#163bc4"/><path d="M56 46a24 24 0 0 1 48 0" fill="none" stroke="#0f1a4a" stroke-width="4"/><circle cx="66" cy="30" r="9" fill="#fff" stroke="#9fb4ff" stroke-width="3"/><circle cx="86" cy="22" r="6" fill="#fff" stroke="#9fb4ff" stroke-width="3"/><circle cx="100" cy="34" r="4" fill="#fff" stroke="#9fb4ff" stroke-width="3"/>${star(126, 24, 10, '#ff6a3d')}${star(34, 72, 7, '#ffc94d')}</svg>`;

  // ménage terminé
  const done = `<svg class="art-done" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="40" fill="#18b98a"/><path d="M42 61l12 12 24-26" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>${star(102, 22, 12, '#ff6a3d', 'twinkle t1')}${star(18, 34, 8, '#ffc94d', 'twinkle t2')}${star(100, 98, 7, '#1f4fff', 'twinkle t3')}</svg>`;

  window.ART = { hero, facade, services, empty, done, star };
})();
