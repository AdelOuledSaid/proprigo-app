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
  // Salon haussmannien (composition originale Proprigo). clean=false : avant ; clean=true : après.
  const room = (clean, label) => {
    const C = clean
      ? { wall: '#f4f6fc', panel: '#e4e9f6', floorA: '#d9a46a', floorB: '#c98f55', glass: '#cfe0ff', curtain: '#ffffff', marble: '#ffffff', mirror: '#dbe7ff', frame: '#e8c77a', rug: '#e3eaff' }
      : { wall: '#e9e4d8', panel: '#dcd5c5', floorA: '#b8a084', floorB: '#a88f72', glass: '#cfcfc6', curtain: '#ece4cf', marble: '#e6e2d8', mirror: '#c9c8bf', frame: '#c4ae7a', rug: '#ddd6c6' };
    let floor = '';
    for (let row = 0; row < 7; row++) for (let col = -1; col < 22; col++) {
      const x = col * 30 + (row % 2) * 15; const y = 330 + row * 16;
      floor += `<path d="M${x} ${y}l15 8l15 -8l0 16l-15 8l-15 -8z" fill="${(row + col) % 2 ? C.floorA : C.floorB}"/>`;
    }
    const roofs = `<path d="M318 210l18-22h40l14 22zM374 228l12-16h36l10 16z" fill="#8fa3c8"/><rect x="318" y="210" width="72" height="70" fill="#f1e6d0"/><rect x="374" y="228" width="58" height="52" fill="#eadcc0"/>
      <rect x="326" y="222" width="10" height="14" fill="#9fb1d4"/><rect x="346" y="222" width="10" height="14" fill="#9fb1d4"/><rect x="366" y="222" width="10" height="14" fill="#9fb1d4"/><rect x="386" y="240" width="10" height="14" fill="#9fb1d4"/><rect x="406" y="240" width="10" height="14" fill="#9fb1d4"/>
      <rect x="350" y="176" width="6" height="14" fill="#c98f55"/><rect x="398" y="200" width="6" height="12" fill="#c98f55"/>`;
    const railing = (() => { let r = '<rect x="304" y="268" width="132" height="5" fill="#0f1a4a"/><rect x="304" y="314" width="132" height="4" fill="#0f1a4a"/>'; for (let i = 312; i < 432; i += 12) r += `<line x1="${i}" y1="273" x2="${i}" y2="314" stroke="#0f1a4a" stroke-width="2.2"/><circle cx="${i + 6}" cy="292" r="4.5" fill="none" stroke="#0f1a4a" stroke-width="1.8"/>`; return r; })();
    const mess = clean ? '' : `
      <path d="M150 304c10-14 40-16 52-6l-8 16c-14-6-30-4-44-10z" fill="#9b8bb5"/><path d="M118 296l26 4-4 12-24-6z" fill="#d97b6a"/>
      <ellipse cx="270" cy="404" rx="12" ry="8" fill="#f2efe6" stroke="#c9c2b0" stroke-width="2"/><ellipse cx="292" cy="414" rx="9" ry="6" fill="#f2efe6" stroke="#c9c2b0" stroke-width="2"/>
      <circle cx="470" cy="392" r="9" fill="#cfc8b6"/><circle cx="486" cy="398" r="6" fill="#cfc8b6"/><circle cx="64" cy="420" r="7" fill="#cfc8b6"/>
      <rect x="226" y="350" width="16" height="12" rx="3" fill="#fff" stroke="#b8b09c" stroke-width="2"/><rect x="246" y="354" width="14" height="10" rx="3" fill="#fff" stroke="#b8b09c" stroke-width="2"/>
      <path d="M330 120q20 30 6 60M380 90q-14 40 4 70M408 150q-10 20 2 40" stroke="#b9b8ae" stroke-width="5" fill="none" opacity=".8" stroke-linecap="round"/>
      <path d="M96 92q30 20 70 4" stroke="#b5ae9c" stroke-width="6" fill="none" opacity=".6"/>`;
    const worker = !clean ? '' : `
      <g>
        <ellipse cx="482" cy="424" rx="34" ry="6" fill="#0f1a4a" opacity=".12"/>
        <path d="M468 330l-6 88h14l6-70 6 70h14l-6-88z" fill="#24305f"/>
        <path d="M460 418h18v8h-22zM488 418h18l4 8h-22z" fill="#0f1a4a"/>
        <path d="M462 246q20-12 40 0l6 90h-52z" fill="#ffffff"/>
        <path d="M464 262h36l6 82h-48z" fill="#1f4fff"/>
        <path d="M470 262q12 10 24 0" fill="none" stroke="#163bc4" stroke-width="3"/>
        <path d="M482 300l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="#ff6a3d"/>
        <path d="M466 252q-24 2-40-40" fill="none" stroke="#ffffff" stroke-width="13" stroke-linecap="round"/>
        <path d="M434 220q-8-14-12-22" fill="none" stroke="#c98b6b" stroke-width="10" stroke-linecap="round"/>
        <rect x="408" y="178" width="20" height="24" rx="4" fill="#5b80ff" transform="rotate(-15 418 190)"/>
        <circle cx="420" cy="196" r="7" fill="#ff6a3d"/>
        <path d="M500 254q14 30 6 58" fill="none" stroke="#ffffff" stroke-width="12" stroke-linecap="round"/>
        <circle cx="506" cy="314" r="6.5" fill="#ff6a3d"/>
        <rect x="474" y="230" width="14" height="16" rx="5" fill="#c98b6b"/>
        <circle cx="482" cy="214" r="20" fill="#c98b6b"/>
        <path d="M462 212q2-24 22-24 18 0 20 18-10-8-22-6-12 2-20 12z" fill="#2b1e1a"/>
        <circle cx="500" cy="196" r="9" fill="#2b1e1a"/>
        <circle cx="475" cy="216" r="2" fill="#2b1e1a"/>
        <path d="M472 225q5 4 10 0" fill="none" stroke="#2b1e1a" stroke-width="2" stroke-linecap="round"/>
      </g>
      <g><path d="M520 392h38l-5 34h-28z" fill="#18b98a"/><rect x="517" y="386" width="44" height="8" rx="4" fill="#13a079"/><circle cx="530" cy="376" r="7" fill="#fff" stroke="#9fb4ff" stroke-width="2.5"/><circle cx="546" cy="370" r="5" fill="#fff" stroke="#9fb4ff" stroke-width="2.5"/></g>`;
    const shine = !clean ? '' : `${star(402, 150, 16, '#ffffff', 'twinkle t1')}${star(356, 110, 9, '#ffffff', 'twinkle t2')}${star(136, 124, 12, '#ff6a3d', 'twinkle t3')}${star(214, 250, 8, '#ffc94d', 'twinkle t2')}${star(560, 120, 11, '#1f4fff', 'twinkle t1')}${star(40, 300, 8, '#ff6a3d', 'twinkle t3')}`;
    return `<svg class="art-room" viewBox="0 0 600 440" role="img" aria-label="${label}">
      <rect width="600" height="440" fill="${C.wall}"/>
      <rect y="0" width="600" height="20" fill="${C.panel}"/><rect y="20" width="600" height="6" fill="${clean ? '#ffffff' : '#efe9dc'}"/>
      ${Array.from({ length: 40 }, (_, i) => `<rect x="${i * 15 + 3}" y="26" width="8" height="6" fill="${C.panel}"/>`).join('')}
      <rect x="460" y="60" width="120" height="150" rx="2" fill="none" stroke="${C.panel}" stroke-width="3"/><rect x="460" y="226" width="120" height="86" rx="2" fill="none" stroke="${C.panel}" stroke-width="3"/>
      <rect x="0" y="318" width="600" height="12" fill="${clean ? '#ffffff' : '#e3dccb'}"/>
      <rect x="0" y="330" width="600" height="110" fill="${C.floorB}"/>${floor}
      <rect x="300" y="46" width="140" height="276" fill="#ffffff"/>
      <rect x="308" y="54" width="124" height="214" fill="${clean ? 'url(#sky)' : C.glass}"/>
      ${clean ? roofs : `<g opacity=".45">${roofs}</g>`}
      ${clean ? '<path d="M318 250l44-180h16l-44 180zM350 256l34-140h10l-34 140z" fill="#fff" opacity=".55"/>' : ''}
      <line x1="370" y1="54" x2="370" y2="268" stroke="#ffffff" stroke-width="6"/><line x1="308" y1="160" x2="432" y2="160" stroke="#ffffff" stroke-width="5"/>
      ${railing}
      <path d="M284 40h20v290h-14c-10-80-12-200-6-290z" fill="${C.curtain}" stroke="${clean ? '#e4e9f6' : '#ddd3bb'}" stroke-width="2"/>
      <path d="M456 40h-20v290h14c10-80 12-200 6-290z" fill="${C.curtain}" stroke="${clean ? '#e4e9f6' : '#ddd3bb'}" stroke-width="2"/>
      <rect x="276" y="36" width="188" height="6" rx="3" fill="#0f1a4a"/>
      <rect x="86" y="70" width="124" height="104" rx="8" fill="${C.frame}"/><rect x="96" y="80" width="104" height="84" rx="4" fill="${C.mirror}"/>
      ${clean ? '<path d="M110 156l30-66h12l-30 66z" fill="#fff" opacity=".7"/>' : ''}
      <rect x="64" y="182" width="168" height="16" rx="4" fill="${C.marble}" stroke="${clean ? '#dfe5f3' : '#cfc8b6'}" stroke-width="2"/>
      <rect x="76" y="198" width="144" height="122" fill="${C.marble}" stroke="${clean ? '#dfe5f3' : '#cfc8b6'}" stroke-width="2"/>
      <path d="M100 320v-70a48 40 0 0 1 96 0v70z" fill="#2a3260"/>
      <path d="M84 210q30 20 20 60M190 214q-10 30 14 50" stroke="${clean ? '#e3e8f5' : '#d4ccb9'}" stroke-width="2" fill="none"/>
      <rect x="96" y="160" width="8" height="22" rx="2" fill="#fff"/><path d="M100 152q4 4 0 8q-4-4 0-8z" fill="#ffc94d"/>
      <path d="M180 182c-4-14 0-22 8-22s12 8 8 22z" fill="${clean ? '#1f4fff' : '#8c95b5'}"/>
      ${clean ? '<circle cx="186" cy="150" r="6" fill="#ffffff"/><circle cx="194" cy="146" r="5" fill="#ffd4c4"/><circle cx="182" cy="142" r="5" fill="#fff4c8"/>' : '<path d="M188 160q-8-10-14-6M188 160q4-12 12-10" stroke="#9c9a6a" stroke-width="2.5" fill="none"/>'}
      <ellipse cx="250" cy="400" rx="200" ry="32" fill="${C.rug}"/>
      <path d="M80 300q0-24 26-24h70q26 0 26 24v70h-122z" fill="${clean ? '#5b80ff' : '#7d88aa'}"/>
      <rect x="66" y="320" width="26" height="62" rx="12" fill="${clean ? '#1f4fff' : '#6b7391'}"/><rect x="190" y="320" width="26" height="62" rx="12" fill="${clean ? '#1f4fff' : '#6b7391'}"/>
      <rect x="86" y="338" width="110" height="36" rx="10" fill="${clean ? '#7b98ff' : '#8f98b6'}"/>
      ${clean ? '<rect x="112" y="300" width="58" height="34" rx="12" fill="#ffc94d" transform="rotate(-6 141 317)"/>' : '<rect x="104" y="318" width="58" height="34" rx="12" fill="#c9ae6a" transform="rotate(28 133 335)"/>'}
      <rect x="82" y="374" width="6" height="22" fill="#0f1a4a"/><rect x="194" y="374" width="6" height="22" fill="#0f1a4a"/>
      <ellipse cx="270" cy="362" rx="44" ry="10" fill="${clean ? '#c98f55' : '#a68c6e'}"/><rect x="266" y="362" width="8" height="40" fill="#0f1a4a"/><ellipse cx="270" cy="404" rx="22" ry="5" fill="#0f1a4a"/>
      ${clean ? '<rect x="258" y="338" width="14" height="22" rx="5" fill="#ffffff" stroke="#9fb4ff" stroke-width="2"/><circle cx="262" cy="330" r="7" fill="#ffffff"/><circle cx="272" cy="326" r="6" fill="#ffd4c4"/><circle cx="268" cy="334" r="5" fill="#fff4c8"/><path d="M282 356h12v-8h-12z" fill="#ffc94d"/>' : ''}
      <path d="M552 318h28l-4 30h-20z" fill="${clean ? '#ff6a3d' : '#b98a74'}"/>
      ${clean ? '<ellipse cx="560" cy="300" rx="8" ry="20" transform="rotate(-20 560 300)" fill="#18b98a"/><ellipse cx="574" cy="296" rx="8" ry="22" transform="rotate(18 574 296)" fill="#13a079"/><ellipse cx="566" cy="286" rx="7" ry="22" fill="#22c896"/>' : '<path d="M562 318q-10-16-22-12M570 318q8-20 20-16M566 318q0-18-4-26" stroke="#9c9a6a" stroke-width="3.5" fill="none" stroke-linecap="round"/>'}
      ${mess}${worker}${shine}
      <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bcd2ff"/><stop offset="1" stop-color="#eef4ff"/></linearGradient></defs>
    </svg>`;
  };
  const hero = facade(true, 'Façade d\'immeuble parisien qui brille après le ménage');

  // petites illustrations des prestations
  const services = {
    bureau: `<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="10" y="12" width="34" height="24" rx="4" fill="#1f4fff"/><rect x="14" y="16" width="26" height="16" rx="2" fill="#bcd2ff"/><path d="M18 30l8-10h4l-8 10z" fill="#fff" opacity=".7"/><rect x="24" y="36" width="6" height="8" fill="#163bc4"/><rect x="18" y="43" width="18" height="4" rx="2" fill="#163bc4"/><rect x="4" y="47" width="56" height="5" rx="2.5" fill="#0f1a4a"/><rect x="8" y="52" width="4" height="8" fill="#0f1a4a"/><rect x="52" y="52" width="4" height="8" fill="#0f1a4a"/><path d="M48 47h10l-2-9h-6z" fill="#ff6a3d"/><ellipse cx="51" cy="34" rx="3" ry="6" transform="rotate(-18 51 34)" fill="#18b98a"/><ellipse cx="56" cy="34" rx="3" ry="6" transform="rotate(18 56 34)" fill="#13a079"/>${star(54, 12, 7, '#ff6a3d')}</svg>`,
    menage: `<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="8" y="30" width="48" height="18" rx="7" fill="#1f4fff"/><rect x="14" y="22" width="36" height="14" rx="6" fill="#5b80ff"/><rect x="5" y="30" width="10" height="16" rx="5" fill="#163bc4"/><rect x="49" y="30" width="10" height="16" rx="5" fill="#163bc4"/><rect x="12" y="48" width="4" height="7" rx="2" fill="#0f1a4a"/><rect x="48" y="48" width="4" height="7" rx="2" fill="#0f1a4a"/>${star(50, 12, 8, '#ff6a3d')}</svg>`,
    airbnb: `<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="12" y="20" width="40" height="34" rx="7" fill="#ff6a3d"/><path d="M24 20v-6a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v6" fill="none" stroke="#0f1a4a" stroke-width="4"/><rect x="12" y="32" width="40" height="5" fill="#e2552b"/><circle cx="44" cy="46" r="7" fill="#ffc94d"/><rect x="41" y="44" width="16" height="4" rx="2" fill="#ffc94d"/>${star(14, 12, 7, '#1f4fff')}</svg>`,
    grand: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M14 26h36l-5 28H19z" fill="#18b98a"/><rect x="11" y="22" width="42" height="7" rx="3.5" fill="#13a079"/><path d="M18 24a14 14 0 0 1 28 0" fill="none" stroke="#0f1a4a" stroke-width="3"/><circle cx="24" cy="16" r="6" fill="#dbe6ff" stroke="#1f4fff" stroke-width="2"/><circle cx="36" cy="11" r="4" fill="#dbe6ff" stroke="#1f4fff" stroke-width="2"/><circle cx="44" cy="17" r="3" fill="#dbe6ff" stroke="#1f4fff" stroke-width="2"/>${star(54, 40, 7, '#ff6a3d')}</svg>`,
  };

  // aucun ménage prévu : un seau qui attend
  const empty = `<svg class="art-empty" viewBox="0 0 160 120" aria-hidden="true"><ellipse cx="80" cy="108" rx="54" ry="7" fill="#dfe7ff"/><path d="M50 50h60l-8 56H58z" fill="#1f4fff"/><rect x="45" y="44" width="70" height="10" rx="5" fill="#163bc4"/><path d="M56 46a24 24 0 0 1 48 0" fill="none" stroke="#0f1a4a" stroke-width="4"/><circle cx="66" cy="30" r="9" fill="#fff" stroke="#9fb4ff" stroke-width="3"/><circle cx="86" cy="22" r="6" fill="#fff" stroke="#9fb4ff" stroke-width="3"/><circle cx="100" cy="34" r="4" fill="#fff" stroke="#9fb4ff" stroke-width="3"/>${star(126, 24, 10, '#ff6a3d')}${star(34, 72, 7, '#ffc94d')}</svg>`;

  // ménage terminé
  const done = `<svg class="art-done" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="40" fill="#18b98a"/><path d="M42 61l12 12 24-26" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>${star(102, 22, 12, '#ff6a3d', 'twinkle t1')}${star(18, 34, 8, '#ffc94d', 'twinkle t2')}${star(100, 98, 7, '#1f4fff', 'twinkle t3')}</svg>`;

  window.ART = { hero, facade, room, services, empty, done, star };
})();
