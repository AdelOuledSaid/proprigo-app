'use strict';
// Proprigo — interface (client, intervenante, administrateur). Aucune bibliothèque externe.
(() => {
  const $app = document.getElementById('app');
  const $nav = document.getElementById('nav');
  let me = null;

  // ---------- outils ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const eur = (n) => { const v = Number(n); return v.toLocaleString('fr-FR', Number.isInteger(v) ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '\u00a0€'; };
  const dayFr = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString(LOC(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const LOC = () => (window.PROPRIGO_I18N ? window.PROPRIGO_I18N.locale() : 'fr-FR'); // langue choisie par l'intervenante
  const dateFr = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString(LOC(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const todayParis = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
  const SIZE = { studio: 'Studio', T2: 'T2', T3: 'T3', maison: 'Maison' };
  const SERVICE = { menage: 'Ménage', grand: 'Grand nettoyage', airbnb: 'Ménage Airbnb', bureau: 'Nettoyage de bureaux' };
  const PRO = ['airbnb', 'bureau']; // prestations aux professionnels : TVA 20 %, pas de crédit d'impôt
  const STATUS = {
    en_attente: ['Recherche en cours', 'warn'], proposee: ['Recherche en cours', 'warn'], attribuee: ['Confirmée', ''],
    en_cours: ['En cours', ''], terminee: ['Terminée', 'ok'], annulee: ['Annulée', 'gray'],
  };
  const PAY = { en_attente_paiement: 'À payer avant intervention', paiement_echoue: 'Paiement non abouti', simule: 'Paiement simulé (version de test)', paye: 'Payé', a_rembourser: 'Remboursement en cours', rembourse: 'Remboursé' };
  const paymentLabel = (b) => {
    if (b.status === 'annulee' && !b.paid) return 'Annulée — non payée';
    if (['rembourse', 'rembourse'].includes(b.payment_status)) {
      const amount = Number(b.refund_amount || 0);
      if (amount > 0 && amount < Number(b.total)) return `Remboursement partiel : ${eur(amount)}`;
      return 'Remboursé';
    }
    return PAY[b.payment_status] || '';
  };
  const pill = (s) => `<span class="pill ${STATUS[s][1]}">${STATUS[s][0]}</span>`;
  const label = (b) => b.service === 'airbnb' ? `Airbnb ${SIZE[b.size]}` : `${SERVICE[b.service]} ${String(b.hours).replace('.', ',')} h`;

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Une erreur est survenue.');
    return data;
  }
  let toastTimer;
  function toast(text) {
    const t = document.getElementById('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }
  const go = (h) => { location.hash = h; };
  const formData = (form) => Object.fromEntries(new FormData(form).entries());

  // ---------- navigation ----------
  const TAB_ICON = {
    home: '<path d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
    book: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M8 12h8"/>',
    list: '<rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    homes: '<path d="M3 20V9l6-4 6 4v11M15 20h6v-8l-6-3"/><path d="M7 13h4M7 16h4"/>',
    user: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
    todo: '<path d="M12 3.5 21 19H3z"/><path d="M12 10v4M12 16.5v.5"/>',
    team: '<circle cx="9" cy="9" r="3.5"/><circle cx="17" cy="10" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0M15 20a4.5 4.5 0 0 1 6-4.2"/>',
    help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17v.5"/>',
  };
  const tabsFor = (role) => ({
    client: [['#/', 'Accueil', 'home'], ['#/reserver', 'Réserver', 'book'], ['#/mes-reservations', 'Ménages', 'list'], ['#/logements', 'Logements', 'homes'], ['#/compte', 'Compte', 'user']],
    intervenante: [['#/intervenante', 'Missions', 'list'], ['#/aide', 'Aide', 'help'], ['#/compte', 'Compte', 'user']],
    admin: [['#/admin', 'Tableau', 'todo'], ['#/aide', 'Aide', 'help'], ['#/compte', 'Compte', 'user']],
  }[role] || []);
  function paintTabbar() {
    const bar = document.getElementById('tabbar');
    const tabs = me ? tabsFor(me.role) : [];
    document.body.classList.toggle('has-tabbar', tabs.length > 0);
    bar.hidden = !tabs.length;
    const here = location.hash.split('?')[0] || '#/';
    bar.innerHTML = tabs.map(([h, t, i]) => `<a href="${h}" ${here === h || (h === '#/' && here === '#') ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TAB_ICON[i]}</svg><span>${t}</span></a>`).join('');
  }
  window.addEventListener('hashchange', () => paintTabbar());

  function renderNav() {
    paintTabbar();
    const links = [];
    if (!me) links.push('<a href="#/"><span class="nav-ico" aria-hidden="true">🏠</span> Particuliers</a>', '<a href="#/pro"><span class="nav-ico" aria-hidden="true">🏢</span> Entreprises</a>', '<a href="#/syndics"><span class="nav-ico" aria-hidden="true">🏛️</span> Syndics</a>', '<a href="#/agences"><span class="nav-ico" aria-hidden="true">🔑</span> Agences immobilières</a>', '<a href="#/recrutement"><span class="nav-ico" aria-hidden="true">🧽</span> Travailler avec nous</a>', '<a href="#/connexion">Se connecter</a>', '<a class="cta" href="#/reserver">Réserver</a>');
    else {
      if (me.role === 'client') links.push('<a href="#/mes-reservations">Mes réservations</a>', '<a href="#/logements">Mes logements</a>', '<a class="cta" href="#/reserver">Réserver</a>');
      if (me.role === 'intervenante') links.push('<a href="#/intervenante">Mes missions</a>');
      if (me.role === 'admin') links.push('<a href="#/admin">Tableau de bord</a>');
      links.push('<a href="#/compte">Mon compte</a>');
      links.push('<button type="button" id="logout">Se déconnecter</button>');
    }
    $nav.innerHTML = links.join('');
    // téléphone : bandeau compact, menu replié ; le bouton Réserver reste visible pour les clients
    const btn = document.getElementById('menuBtn');
    const quick = document.getElementById('quickCta');
    quick.hidden = !(!me || me.role === 'client');
    const close = () => { $nav.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); };
    btn.onclick = () => { const o = $nav.classList.toggle('open'); btn.setAttribute('aria-expanded', String(o)); };
    $nav.querySelectorAll('a').forEach((x) => x.addEventListener('click', close));
    window.addEventListener('hashchange', close, { once: true });
    const lo = document.getElementById('logout');
    if (lo) lo.onclick = async () => { await nativeForget(); await api('POST', '/api/logout', {}); me = null; go('#/'); route(); };
  }

  let CONFIG = {};
  // Nouvelle version en ligne : un onglet ouvert depuis longtemps garde l'ancien code en mémoire.
  // On vérifie toutes les 5 minutes et au retour sur l'onglet, puis on propose de recharger.
  const checkVersion = async () => {
    if (!window.__proprigoVersion || document.getElementById('newVersion')) return;
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const h = await r.json();
      if (h.version && h.version !== window.__proprigoVersion) {
        document.body.insertAdjacentHTML('beforeend', `<div id="newVersion" class="new-version" role="status"><span>Une nouvelle version de Proprigo est en ligne.</span><button class="btn blue small-btn" type="button">Mettre à jour</button></div>`);
        document.querySelector('#newVersion button').onclick = () => location.reload();
      }
    } catch { /* hors ligne : on réessaiera */ }
  };
  setInterval(checkVersion, 5 * 60e3);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });
  // Prix en vigueur (envoyés par le serveur, modifiables dans l'admin) ; valeurs de secours si hors ligne.
  const PRICES = () => CONFIG.prices || { menage: 36, grand: 44, bureau: 43.2, bureauHT: 36, airbnb: { studio: 99, T2: 125, T3: 152, maison: 205 }, kit: 15, sunday: 0.2, urgent: 0.25, subscription: 0.1 };
  const pct = (x) => `${Math.round(x * 100)} %`;
  // Crédit d'impôt : affiché seulement une fois la déclaration « services à la personne » enregistrée dans l'admin.
  const sapOn = () => Boolean(CONFIG.sap && CONFIG.sap.declared);
  const afterCredit = (n) => `soit ${String(Math.round(n * 50) / 100).replace('.', ',')} € après crédit d'impôt`;
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
  async function loadMe() {
    const r = await api('GET', '/api/me');
    me = r.user;
    if (!CONFIG.loaded) CONFIG = { ...(await api('GET', '/api/config').catch(() => ({}))), loaded: true };
    // Version de cette page : celle écrite par le serveur dans la page au chargement.
    if (!window.__proprigoVersion) window.__proprigoVersion = document.querySelector('meta[name="proprigo-version"]')?.content || CONFIG.version;
    const vEl = document.getElementById('appVersion');
    if (vEl && window.__proprigoVersion) vEl.textContent = `Version ${window.__proprigoVersion}`;
    if (me && !loadMe.nativeDone) { loadMe.nativeDone = true; try { nativeRefresh(); } catch { /* appli web */ } }
    applyLang();
  }

  const views = {};

  const AIR_HOURS = { studio: 2, T2: 2.5, T3: 3, maison: 4 };
  const DEFAULT_TASKS = {
    menage: ['Cuisine : plans de travail, évier, extérieur des appareils', 'Salle de bain et WC', 'Sols : aspirateur et serpillière', 'Poussière des surfaces', 'Vider les poubelles'],
  };
  DEFAULT_TASKS.grand = [...DEFAULT_TASKS.menage, 'Intérieur du four et du réfrigérateur', 'Vitres accessibles', 'Intérieur des placards'];
  DEFAULT_TASKS.bureau = ['Bureaux : poussière des postes de travail, sans déplacer les dossiers', 'Vider les corbeilles et trier les déchets', 'Sols : aspirateur et serpillière', 'Cuisine ou coin café : plans de travail, évier, machine à café', 'Sanitaires : nettoyage et réassort (papier, savon)', 'Salle de réunion : tables et chaises', 'Poignées de porte et interrupteurs'];
  DEFAULT_TASKS.airbnb = [...DEFAULT_TASKS.menage, 'Changer les draps et les serviettes', 'Faire les lits', 'Réassort : papier toilette, savon, café', "Vérifier l'état du logement et signaler tout dégât"];
  const WEEKDAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const HALF_HOURS = Array.from({ length: 33 }, (_, i) => `${String(6 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
  const draftHours = (d) => (d.service === 'airbnb' ? AIR_HOURS[d.size] : Number(d.hours) + (['menage', 'grand'].includes(d.service) ? (d.extras || []).reduce((t, k) => t + ({ repassage: 1, vitres: 1, four: 0.5, frigo: 0.5, draps: 0.5 }[k] || 0), 0) : 0));

  // Messagerie d'une réservation (client, intervenante, équipe)
  async function openThread(box, id, quick = []) {
    const msgs = await api('GET', `/api/bookings/${id}/messages`);
    box.innerHTML = `<div class="thread">
      ${msgs.length ? msgs.map((m) => `<p class="bubble ${m.mine ? 'me' : ''}"><span class="small muted">${esc(m.name)} · ${new Date(m.created_at.replace(' ', 'T') + 'Z').toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' })}</span><br>${esc(m.text)}</p>`).join('') : '<p class="small muted">Aucun message. Les numéros de téléphone et e-mails sont masqués automatiquement.</p>'}
      ${quick.length ? `<div class="chips">${quick.map((q) => `<button type="button" data-quick="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : ''}
      <form class="row" style="flex-wrap:nowrap"><input type="text" name="text" maxlength="1000" placeholder="Votre message" aria-label="Votre message" required style="margin:0"><button class="btn blue">Envoyer</button></form>
    </div>`;
    const send = async (text) => { try { await api('POST', `/api/bookings/${id}/messages`, { text }); openThread(box, id, quick); } catch (e) { toast(e.message); } };
    box.querySelector('form').onsubmit = (e) => { e.preventDefault(); send(e.target.text.value); };
    box.querySelectorAll('[data-quick]').forEach((b) => b.onclick = () => send(b.dataset.quick));
  }
  function bindThreads(quick) {
    $app.querySelectorAll('[data-thread]').forEach((btn) => btn.onclick = () => {
      const box = document.getElementById(`thread-${btn.dataset.thread}`);
      if (box.innerHTML) { box.innerHTML = ''; return; }
      openThread(box, btn.dataset.thread, quick).catch((e) => toast(e.message));
    });
  }

  // Réduit une photo à 1600 px maximum avant l'envoi (plus léger sur mobile).
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1600 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => reject(new Error('Image illisible.'));
      img.src = URL.createObjectURL(file);
    });
  }

  // photo de profil : recadrée en carré au centre, 480 px
  function squareShrink(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const c = document.createElement('canvas'); c.width = c.height = Math.min(480, side);
        c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('Image illisible.'));
      img.src = URL.createObjectURL(file);
    });
  }
  const avatar = (id, has, name, cls = '') => has
    ? `<img class="av ${cls}" src="/api/workers/${id}/avatar" alt="Photo de ${esc(name)}" loading="lazy">`
    : `<span class="av ${cls}" aria-hidden="true">${esc(String(name || '?').slice(0, 1))}</span>`;
  const addDaysFront = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const tomorrowParis = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(Date.now() + 864e5));
  const DRAFT0 = () => ({ step: 1, service: 'menage', size: 'T2', hours: 3, kit: false, extras: [], lease: null, cp: '', address: '', date: tomorrowParis(), time: null, urgent: false, repeat: '0', occurrences: 8, photoConsent: false, tasks: null, tasksService: null, home_id: null, cgv: false, payment_mode: 'all' });
  let draft = DRAFT0();
  const FREE_CANCEL = "Annulation gratuite jusqu'à 24 h avant le ménage. Ensuite, 50 % du prix est retenu.";
  const ICON = {
    menage: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 11.5 12 4l8.5 7.5M6 10v10h12V10"/><path d="M10 20v-5h4v5"/></svg>',
    grand: '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true"><path d="M12 2.5c.6 4.6 2.3 6.4 7 7-4.7.6-6.4 2.4-7 7-.6-4.6-2.3-6.4-7-7 4.7-.6 6.4-2.4 7-7z"/><path d="M19 15.5c.25 1.9.9 2.6 2.8 2.8-1.9.25-2.55.9-2.8 2.8-.25-1.9-.9-2.55-2.8-2.8 1.9-.2 2.55-.9 2.8-2.8z"/></svg>',
    airbnb: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3.5M21 12v2.5"/></svg>',
  };
  // options (temps en plus) et forfait fin de bail
  const EXTRAS = { repassage: { label: 'Repassage', hours: 1 }, vitres: { label: 'Vitres intérieures', hours: 1 }, four: { label: 'Intérieur du four', hours: 0.5 }, frigo: { label: 'Intérieur du réfrigérateur', hours: 0.5 }, draps: { label: 'Changement des draps', hours: 0.5 } };
  const OPTIONABLE = ['menage', 'grand'];
  const LEASE = { studio: { label: 'Studio', hours: 4 }, T2: { label: '2 pièces', hours: 5 }, T3: { label: '3 pièces', hours: 7 }, maison: { label: 'Maison', hours: 8 } };
  const LEASE_TASKS = ['Cuisine : intérieur des placards, four, réfrigérateur, hotte, plaques', 'Salle de bain : calcaire, joints, robinetterie, miroir', 'WC : cuvette, abattant, sol, murs autour', 'Sols de toutes les pièces : aspirateur et serpillière', 'Plinthes, portes, poignées et interrupteurs', 'Intérieur des placards et penderies', 'Vitres intérieures accessibles', 'Traces sur les murs (quand c\'est possible)', 'Radiateurs et grilles de ventilation'];
  const SERVICE_HINT = { menage: 'Ménage courant, à l\'heure', grand: 'Fin de bail, remise en état', airbnb: 'Forfait ménage + linge', bureau: 'Locaux professionnels' };
  const dateLong = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

  // ---------- accueil ----------
  views[''] = async (params) => {
    if (params && /^\d{5}$/.test(params.get('cp') || '')) draft.cp = params.get('cp'); // venu d'une page de ville
    if (me && me.role === 'intervenante') return go('#/intervenante');
    if (me && me.role === 'admin') return go('#/admin');
    if (me && me.role === 'client') return clientHome();
    const ICO = {
      lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
      clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
      badge: '<path d="M12 3l7 3v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6z"/><path d="m8.8 12 2.2 2.2 4.4-4.6"/>',
      swap: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
      back: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/><path d="M9 12.5l2 2 4-4"/>',
    };
    const ico = (k) => `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICO[k]}</svg>`;
    // Prix en vigueur, envoyés par le serveur (modifiables par le responsable dans l'admin).
    const P = PRICES();
    const eu = (n) => (Number.isInteger(Number(n)) ? String(n) : Number(n).toFixed(2)).replace('.', ','); // 43.2 → « 43,20 »
    const AIR = [['studio', 'Studio', P.airbnb.studio], ['T2', '2 pièces', P.airbnb.T2], ['T3', '3 pièces', P.airbnb.T3], ['maison', 'Maison', P.airbnb.maison]];
    $app.innerHTML = `
      <section class="hero2">
        <div class="hero2-text">
          <h1>Chez vous, tout brille.</h1>
          <p class="lead">Ménage à domicile, logements Airbnb, grand nettoyage et bureaux à Paris et en Île-de-France. Des intervenantes vérifiées, un prix connu avant de payer.</p>
          <div class="live-mini" aria-label="Les étapes de votre ménage">${liveSteps(true)}</div>
          <form class="card stack choose" id="start">
            <div class="svc svc4">${['menage', 'airbnb', 'grand', 'bureau'].map((k) => `<button type="button" data-pick="${k}" aria-pressed="${draft.service === k}"><span class="svc-art">${ART.services[k]}</span><b>${k === 'menage' ? 'À domicile' : SERVICE[k]}</b><span>${{ menage: `${eu(P.menage)} € / h`, airbnb: `dès ${eu(P.airbnb.studio)} €`, grand: `${eu(P.grand)} € / h`, bureau: CONFIG.franchiseTVA ? `${eu(P.bureau)} € / h` : `${eu(P.bureauHT)} € HT / h` }[k]}</span></button>`).join('')}</div>
            <nav class="pro-links" aria-label="Pour les professionnels"><span>Vous êtes un professionnel ?</span><a href="#/pro">🏢 Entreprises</a><a href="#/syndics">🏛️ Syndics</a><a href="#/agences">🔑 Agences immobilières</a></nav>
            <div class="cp-row">
              <label>Code postal du logement<input type="text" name="cp" inputmode="numeric" maxlength="5" autocomplete="postal-code" value="${esc(draft.cp)}" placeholder="Ex. 75011" required></label>
              <button class="btn primary">Voir les créneaux</button>
            </div>
            <p class="msg" id="zone"></p>
          </form>
        </div>
        <figure class="ba" id="ba">
          <div class="ba-layer">${ART.room(false, 'Avant le ménage : salon en désordre, vitre ternie')}</div>
          <div class="ba-layer ba-clean" id="baClean">${ART.room(true, 'Après le ménage : salon rangé, vitre qui brille, intervenante Proprigo au travail')}</div>
          <div class="ba-handle" id="baHandle" aria-hidden="true"><span><svg viewBox="0 0 32 32" width="22" height="22">${ART.star(16, 16, 13, '#ff6a3d')}</svg></span></div>
          <input type="range" min="0" max="100" value="50" id="baRange" aria-label="Avant et après le ménage : faites glisser pour faire briller">
          <figcaption><span>Avant</span><b>Faites glisser pour faire briller</b><span>Après</span></figcaption>
        </figure>
      </section>

      <ul class="promises">
        <li>${ico('lock')}<span><b>Paiement sécurisé</b>Par carte, avec Stripe</span></li>
        <li>${ico('clock')}<span><b>Annulation gratuite</b>Jusqu'à 24 h avant</span></li>
        <li>${ico('badge')}<span><b>Intervenantes vérifiées</b>Identité, entretien, suivi qualité</span></li>
        <li>${ico('swap')}<span><b>Remplaçante prévue</b>Si votre intervenante est absente</span></li>
        <li>${ico('back')}<span><b>Satisfait ou on revient</b>Gratuitement, si vous le signalez sous 48 h</span></li>
      </ul>

      <section class="live-band" aria-labelledby="liveT">
        <div class="live-head"><h2 id="liveT">Suivez votre ménage en direct</h2><p>Vous êtes prévenu à chaque étape, jusqu'à la fin du ménage.</p></div>
        ${liveSteps()}
      </section>

      <a class="gift-band" href="#/cadeau"><span class="gift-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="9" width="17" height="11" rx="2"/><path d="M3.5 13h17M12 9v11M12 9S10.5 4 8 4.5 7 9 12 9zM12 9s1.5-5 4-4.5S17 9 12 9z"/></svg></span><span><b>Pour Noël, offrez un ménage</b><span>Cartes cadeaux de 50 à 200 €, envoyées par e-mail</span></span><span class="gift-go">Offrir</span></a>

      <section class="offers" aria-labelledby="offersT">
        <h2 id="offersT">Quatre prestations, un prix clair</h2>
        <div class="offer-grid">
          <article class="offer">
            <span class="offer-art">${ART.services.menage}</span>
            <h3>Ménage à domicile</h3>
            <p class="offer-price"><b>${eu(P.menage)} €</b> de l'heure</p>${sapOn() ? `<p class="small offer-credit">${afterCredit(P.menage)}</p>` : ''}
            <ul><li>Cuisine, salle de bain, sols, poussière</li><li>Même intervenante chaque semaine si vous le souhaitez</li><li>Checklist personnalisée</li></ul>
            <button class="btn ghost full" data-book="menage">Réserver ce ménage</button>
          </article>
          <article class="offer offer-feature">
            <span class="offer-art">${ART.services.airbnb}</span>
            <h3>Ménage Airbnb</h3>
            <p class="offer-price"><b id="airPrice">${eu(P.airbnb.T2)} €</b> le forfait, linge compris</p>
            <div class="chips" role="group" aria-label="Taille du logement">${AIR.map(([k, t]) => `<button type="button" data-air="${k}" data-price="${String(P.airbnb[k]).replace('.', ',')}" aria-pressed="${k === 'T2'}">${t}</button>`).join('')}</div>
            <ul><li>Ménage et changement du linge entre deux voyageurs</li><li>Calendrier de l'annonce synchronisé</li><li>Photos avant / après sur demande</li></ul>
            <button class="btn primary full" data-book="airbnb">Réserver pour mon logement</button>
          </article>
          <article class="offer">
            <span class="offer-art">${ART.services.grand}</span>
            <h3>Grand nettoyage</h3>
            <p class="offer-price"><b>${eu(P.grand)} €</b> de l'heure</p>${sapOn() ? `<p class="small offer-credit">${afterCredit(P.grand)}</p>` : ''}
            <ul><li>Fin de bail, emménagement, remise en état</li><li>Intérieur des placards, plinthes, vitres accessibles</li><li>Matériel apporté sur demande</li></ul>
            <button class="btn ghost full" data-book="grand">Réserver ce ménage</button>
          </article>
          <article class="offer">
            <span class="offer-art">${ART.services.bureau}</span>
            <h3>Nettoyage de bureaux</h3>
            <p class="offer-price"><b>${eu(CONFIG.franchiseTVA ? P.bureau : P.bureauHT)} €</b> ${CONFIG.franchiseTVA ? '' : 'HT '}de l'heure</p>
            <ul><li>Postes de travail, sols, sanitaires, coin café</li><li>Avant l'ouverture ou après la fermeture</li><li>Chaque semaine avec la même intervenante, une facture par passage</li></ul>
            <button class="btn ghost full" data-book="bureau">Demander un passage</button>
            <a class="small" href="#/pro" style="text-align:center">Grands locaux, agences, syndics : devis</a>
          </article>
        </div>
        <p class="small muted offers-note">${CONFIG.franchiseTVA ? "Prix en Île-de-France, TVA non applicable (art. 293 B du CGI)." : `Prix TTC en Île-de-France (bureaux : ${eu(P.bureauHT)} € HT, soit ${eu(P.bureau)} € TTC).`} Matériel et produits apportés : +${eu(P.kit)} €. Dimanche et jours fériés : +${Math.round(P.sunday * 100)} %. Arrivée dans les 3 heures : +${Math.round(P.urgent * 100)} %.</p>
      </section>

      <section class="live">
        <div class="phone" aria-hidden="true">
          <div class="phone-screen">
            <div class="hello mini"><div class="hello-text"><p class="hello-hi">Bonjour Claire</p><h1>Votre ménage est en cours</h1><p class="hello-when">Mardi à 10:00</p>
              <ol class="track"><li class="done">Réservé</li><li class="done">Confirmée</li><li class="now">En cours</li><li>Terminé</li></ol></div></div>
            <div class="card mini-card">
              <div class="shine"><div class="shine-top"><b>Presque fini</b><span>4 sur 5</span></div><div class="shine-bar"><i class="shine-demo"></i></div></div>
              <p class="mini-line"><b>Fatima</b>, intervenante vérifiée</p>
              <p class="mini-line muted">Cuisine ✓ · Salle de bain ✓ · Sols ✓ · Poussière ✓</p>
            </div>
          </div>
        </div>
        <div class="live-text">
          <h2>Vous suivez votre ménage en direct</h2>
          <ol class="flow">
            <li><b>Vous réservez en 2 minutes</b><span>Le type de ménage, la date, l'heure. Le prix total s'affiche avant de payer.</span></li>
            <li><b>Vous savez qui vient</b><span>Le prénom de votre intervenante vérifiée, avant le ménage. Vous pouvez la garder pour les prochaines fois.</span></li>
            <li><b>Vous voyez où elle en est</b><span>Chaque tâche cochée fait avancer la jauge. Messages, photos et reçu restent dans votre espace.</span></li>
          </ol>
        </div>
      </section>

      <section class="hosts">
        <div>
          <h2>Hôtes Airbnb et conciergeries</h2>
          <p>Reliez le calendrier de votre annonce : un ménage est proposé après chaque départ de voyageurs, avec la même intervenante, vos consignes et votre checklist.</p>
          <a class="btn primary" href="#/inscription" id="hostCta">Ajouter mon logement</a>
        </div>
        <ul>
          <li>Calendrier Airbnb, Abritel ou Booking synchronisé</li>
          <li>Une intervenante préférée par logement</li>
          <li>Consignes d'accès et checklist enregistrées</li>
          <li>Un séjour annulé ne supprime jamais un ménage sans votre accord</li>
        </ul>
      </section>

      <section class="reviews" id="homeReviews" aria-labelledby="revT" hidden></section>

      <section class="faq-home">
        <h2>Questions fréquentes</h2>
        <details class="faq"><summary>Et si je ne suis pas satisfait ?</summary><p>Signalez-le dans les 48 h depuis votre réservation (bouton « On revient »). Nous revenons reprendre les points concernés, gratuitement.</p></details>
        <details class="faq"><summary>Qui vient chez moi ?</summary><p>Une intervenante sélectionnée par Proprigo : identité vérifiée, entretien, première mission accompagnée. Vous voyez son prénom avant le ménage.</p></details>
        <details class="faq"><summary>Dois-je fournir le matériel ?</summary><p>Vous pouvez fournir aspirateur et produits, ou choisir l'option « matériel apporté » pour 15 €. Pour un logement Airbnb, le matériel reste sur place.</p></details>
        <details class="faq"><summary>Puis-je annuler ou changer l'heure ?</summary><p>Oui, depuis votre espace. C'est gratuit jusqu'à 24 h avant le ménage ; ensuite, 50 % du prix est retenu.</p></details>
        <details class="faq"><summary>Et si mon intervenante est absente ?</summary><p>L'équipe cherche une remplaçante vérifiée et vous prévient. Vous pouvez aussi choisir un autre créneau pour garder la vôtre.</p></details>
        <p><a href="#/aide">Toutes les questions</a></p>
      </section>

      <section class="final">
        <h2>On s'occupe de votre ménage ?</h2>
        <form id="start2" class="cp-row">
          <label>Code postal<input type="text" name="cp" inputmode="numeric" maxlength="5" autocomplete="postal-code" placeholder="Ex. 75011" required></label>
          <button class="btn primary">Voir les créneaux</button>
        </form>
        <p class="small">Vous faites le ménage ? <a href="#/recrutement">Travaillez avec Proprigo</a></p>
      </section>`;
    // Avis réels des clients (publiés avec leur accord). Affichés seulement à partir de 3 notes.
    api('GET', '/api/reviews').then((rv) => {
      const box = document.getElementById('homeReviews');
      if (!box || rv.count < 3 || !rv.list.length) return;
      const stars = (n) => `<span class="rv-stars" aria-label="${n} sur 5">${'★'.repeat(n)}<span aria-hidden="true">${'★'.repeat(5 - n)}</span></span>`;
      const month = (m) => new Date(m + '-15T12:00:00Z').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      box.innerHTML = `<h2 id="revT">Ce que disent nos clients</h2>
        <p class="rv-summary"><b>${String(rv.average).replace('.', ',')}/5</b> sur ${rv.count} avis de clients ayant réservé un ménage</p>
        <div class="rv-grid">${rv.list.map((r) => `<figure class="rv-card">${stars(r.stars)}<blockquote>${esc(r.text)}</blockquote>
          <figcaption><b>${esc(r.author)}</b> · ${esc(r.service)}${r.place ? `, ${esc(r.place)}` : ''} · ${month(r.month)}</figcaption></figure>`).join('')}</div>
        <p class="small muted">Avis publiés avec l'accord de leurs auteurs. La note moyenne compte tous les avis reçus.</p>`;
      box.hidden = false;
    }).catch(() => {});
    // avant / après : on glisse pour faire briller
    const range = document.getElementById('baRange');
    const paintBA = () => {
      const v = Number(range.value);
      document.getElementById('baClean').style.clipPath = `inset(0 0 0 ${v}%)`;
      document.getElementById('baHandle').style.left = `${v}%`;
    };
    range.oninput = paintBA;
    paintBA();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // un seul balayage au chargement, pour montrer le geste
      const t0 = performance.now();
      const sweep = (t) => {
        if (range.dataset.touched) return;
        const k = Math.min(1, (t - t0) / 1600);
        const e = k < 0.5 ? 2 * k * k : 1 - (2 - 2 * k) ** 2 / 2;
        range.value = String(Math.round(82 - (82 - 30) * e));
        paintBA();
        if (k < 1) requestAnimationFrame(sweep);
      };
      setTimeout(() => requestAnimationFrame(sweep), 450);
    }
    range.addEventListener('pointerdown', () => { range.dataset.touched = '1'; });
    // tailles Airbnb
    $app.querySelectorAll('[data-air]').forEach((b) => b.onclick = () => {
      $app.querySelectorAll('[data-air]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      document.getElementById('airPrice').textContent = `${b.dataset.price} €`;
      draft.size = b.dataset.air;
    });
    // les boutons « Réserver » remontent au formulaire avec la prestation choisie
    $app.querySelectorAll('[data-book]').forEach((b) => b.onclick = () => {
      draft.service = b.dataset.book;
      $app.querySelectorAll('[data-pick]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.pick === draft.service));
      document.getElementById('start').scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => document.querySelector('#start [name=cp]').focus({ preventScroll: true }), 400);
    });
    document.getElementById('hostCta').onclick = () => { draft.service = 'airbnb'; sessionStorage.setItem('after', '#/logements'); };
    document.getElementById('start2').onsubmit = (e) => {
      e.preventDefault();
      const f = document.getElementById('start');
      f.cp.value = e.target.cp.value;
      f.requestSubmit();
      f.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    $app.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => {
      draft.service = b.dataset.pick;
      $app.querySelectorAll('[data-pick]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    });
    const form = document.getElementById('start');
    form.onsubmit = async (e) => {
      e.preventDefault();
      draft.cp = form.cp.value.trim();
      const q = await api('POST', '/api/quote', { service: draft.service, size: draft.size, hours: draft.hours, cp: draft.cp, date: draft.date });
      const z = document.getElementById('zone');
      if (!q.zone) { z.className = 'msg warn'; z.textContent = 'Entrez un code postal à 5 chiffres.'; return; }
      if (!q.open) {
        z.className = 'msg warn';
        z.innerHTML = `Proprigo n'est pas encore ouvert au ${esc(draft.cp)}. <a href="#/" id="wlLink">Être prévenu de l'ouverture</a>`;
        document.getElementById('wlLink').onclick = (ev) => {
          ev.preventDefault();
          z.innerHTML = '<span class="row" style="flex-wrap:nowrap"><input type="email" id="wlMail" placeholder="Votre e-mail" aria-label="Votre e-mail" style="margin:0"><button type="button" class="btn blue" id="wlGo">OK</button></span>';
          document.getElementById('wlGo').onclick = async () => {
            try { await api('POST', '/api/waitlist', { email: document.getElementById('wlMail').value, cp: draft.cp }); z.className = 'msg ok'; z.textContent = "C'est noté : nous vous prévenons dès l'ouverture."; } catch (err) { toast(err.message); }
          };
        };
        return;
      }
      draft.step = 1;
      go('#/reserver');
    };
  };

  // ---------- accueil du client : prochain ménage ----------
  const TRACK = ['Réservé', 'Confirmé', 'En route', 'En cours', 'Terminé'];
  // bande des 5 étapes de l'accueil (version courte sous la photo, version complète plus bas)
  const liveSteps = (mini = false) => `<ol class="live-steps${mini ? ' mini' : ''}">${[['📝', 'Réservé', 'En ligne, en 2 min'], ['👍', 'Confirmé', 'Intervenante choisie'], ['🚶', 'En route', "Heure d'arrivée"], ['🧽', 'En cours', 'Tâches cochées'], ['✨', 'Terminé', 'Photos et avis']]
    .map(([e, t, d], i) => `<li style="--i:${i}"><span class="live-dot" aria-hidden="true">${e}</span><b>${t}</b>${mini ? '' : `<small>${d}</small>`}</li>`).join('')}</ol>`;
  const TRACK_ICON = ['📝', '👍', '🚶', '🧽', '✨']; // une image par étape : compréhensible même sans lire
  const trackIndex = (b) => (b.status === 'terminee' ? 4 : b.status === 'en_cours' ? 3 : b.status === 'attribuee' ? (b.on_way_at ? 2 : 1) : 0);
  function tracker(b) {
    const i = trackIndex(b);
    const labels = [...TRACK];
    const icons = [...TRACK_ICON];
    if (b.status === 'attribuee' && b.arrived_at) { labels[2] = 'Arrivée'; icons[2] = '📍'; }
    return `<ol class="track five">${labels.map((t, k) => `<li class="${k < i ? 'done' : k === i ? 'now' : ''}"><span class="t-ico" aria-hidden="true">${icons[k]}</span>${t}</li>`).join('')}</ol>`;
  }
  // fiche de l'intervenante (prénom, ancienneté, note réelle, langues, présentation)
  async function workerCard(id) {
    let c;
    try { c = await api('GET', `/api/workers/${id}/card`); } catch { return ''; }
    const meta = ['Intervenante vérifiée', c.missions ? `${c.missions} ménage${c.missions > 1 ? 's' : ''}` : '', c.rating ? `★ ${String(c.rating).replace('.', ',')} (${c.ratings} avis)` : ''].filter(Boolean).join(' · ');
    return `<div class="wcard">
      ${avatar(c.id, c.photo, c.firstName, 'wcard-av')}
      <div class="wcard-name">${esc(c.displayName || c.firstName)}${c.tier && c.tier.key !== 'bleu' ? ` <span class="tier-pill ${c.tier.key}">${c.tier.icon} Intervenante ${esc(c.tier.label)}</span>` : ''}</div>
      <div class="wcard-meta">${esc(meta)}${c.languages ? `<br>Parle ${esc(c.languages)}` : ''}</div>
      ${c.bio ? `<p class="wcard-bio">${esc(c.bio)}</p>` : ''}
      ${c.reviews.length ? `<p class="wcard-rev">« ${esc(c.reviews[0].review)} »</p>` : ''}
    </div>`;
  }
  function rebook(b) {
    draft = { ...DRAFT0(), step: 2, service: b.service, size: b.size || 'T2', hours: b.hours, kit: !!b.kit, cp: b.cp, address: b.address, photoConsent: !!b.photo_consent, home_id: b.home_id || null, tasks: b.checklist.map((t) => t.task), tasksService: b.service };
    go('#/reserver');
  }

  async function clientHome() {
    const list = await api('GET', '/api/bookings/mine');
    const upcoming = list.filter((b) => ['en_attente', 'proposee', 'attribuee', 'en_cours'].includes(b.status)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const next = upcoming[0];
    const toRate = list.find((b) => b.status === 'terminee' && !b.rating);
    const last = list.find((b) => b.status === 'terminee');
    $app.innerHTML = `
      <section class="hello">
        <div class="hello-text">
          <p class="hello-hi">Bonjour ${esc(me.name.split(' ')[0])}</p>
          <h1>${next ? (next.status === 'en_cours' ? 'Votre ménage est en cours' : 'Votre prochain ménage') : 'Aucun ménage prévu'}</h1>
          ${next ? `<p class="hello-when">${esc(dateLong(next.date))} à ${esc(next.time)}</p>${tracker(next)}` : `<p class="hello-sub">Choisissez une date : l'équipe vous confirme l'intervenante.</p>
            ${last ? `<button class="btn primary" data-again="${last.id}">Refaire le même ménage</button>` : '<a class="btn primary" href="#/reserver" id="newB0">Réserver un ménage</a>'}`}
        </div>
        <div class="hello-art" aria-hidden="true">${next ? ART.services[next.service] || ART.services.menage : ART.empty}</div>
      </section>
      ${next ? `
        <article class="card next">
          ${next.status === 'attribuee' && next.on_way_at ? `<p class="live-line"><span class="live-dot"></span>${next.arrived_at ? `${esc((next.worker_name || '').split(' ')[0])} est arrivée chez vous.` : `${esc((next.worker_name || '').split(' ')[0])} est en route${next.eta_at ? `, arrivée estimée vers ${hhmm(next.eta_at)}` : ''}.`}</p>` : ''}
          ${next.worker_id ? '<div id="wcardHost"></div>' : ''}
          ${next.status === 'en_cours' && next.checklist.length ? shine(next) : ''}
          <dl class="facts">
            ${next.worker_id ? '' : `<div><dt>Intervenante</dt><dd>L'équipe vous confirme votre intervenante très vite</dd></div>`}
            <div><dt>Adresse</dt><dd>${esc(next.address)}, ${esc(next.cp)}</dd></div>
            <div><dt>Prestation</dt><dd>${esc(label(next))} · <b>${eur(next.total)}</b></dd></div>
          </dl>
          ${next.ical_flagged && ['en_attente', 'proposee', 'attribuee'].includes(next.status) ? `<div class="notice"><b>Ce séjour n'apparaît plus dans le calendrier de votre annonce.</b> Le ménage reste prévu. Si le séjour est bien annulé, annulez le ménage ; sinon, gardez-le.<div class="actions"><button class="btn ghost" data-keep="${next.id}">Garder le ménage</button><button class="btn ghost" data-cancel="${next.id}">Annuler le ménage</button></div></div>` : ''}
          ${next.preferred_id && next.worker_id !== next.preferred_id ? `<p class="notice"><b>${esc(next.preferred_name)}, votre intervenante préférée, n'est pas disponible à ce créneau.</b> L'équipe recherchera une intervenante et vous confirmera son attribution. Pour la garder, choisissez un autre créneau via « Modifier ».</p>` : ''}
          <div class="actions">
            ${['en_attente', 'proposee', 'attribuee'].includes(next.status) && (Date.parse(`${next.date}T${next.time}:00`) - Date.now()) / 36e5 >= 24 ? `<button class="btn ghost" data-edit="${next.id}">Modifier</button>` : ''}
            <button class="btn ghost" data-thread="${next.id}">Contacter${next.messages ? ` (${next.messages})` : ''}</button>
            <button class="btn ghost" data-again="${next.id}">Réserver à nouveau</button>
          </div>
          <div id="thread-${next.id}"></div>
        </article>` : ''}
      <a class="book-cta" href="#/compte" id="refCta"><span class="book-ico gift"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="9" width="17" height="11" rx="2"/><path d="M3.5 13h17M12 9v11M12 9S10.5 4 8 4.5 7 9 12 9zM12 9s1.5-5 4-4.5S17 9 12 9z"/></svg></span><span><b>Offrez 10 € à un proche</b><span>Et recevez 10 € après son premier ménage</span></span></a>
      <a class="book-cta" href="#/reserver" id="newB"><span class="book-ico"><svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">${ART.star(16, 16, 13, '#fff')}</svg></span><span><b>Réserver un ménage</b><span>À domicile, Airbnb ou grand nettoyage</span></span></a>
      ${upcoming.length > 1 ? `<section class="card"><h3>À venir</h3><ul class="plain">${upcoming.slice(1, 6).map((b) => `<li><span><b>${dateFr(b.date)}</b> ${esc(b.time)} · ${esc(label(b))}</span><span>${b.worker_name ? esc(b.worker_name.split(' ')[0]) : '<span class="muted">à confirmer</span>'}</span></li>`).join('')}</ul></section>` : ''}
      ${toRate ? `<section class="card"><h3>Comment s'est passé le ménage du ${dateFr(toRate.date)} ?</h3><div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-rate="${toRate.id}" data-stars="${n}" aria-label="${n} sur 5">★</button>`).join('')}</div></section>` : ''}
      <nav class="quick" aria-label="Raccourcis"><a href="#/mes-reservations">Toutes mes réservations et reçus</a><a href="#/logements">Mes logements</a><a href="#/aide">Aide et réclamations</a></nav>`;
    document.getElementById('newB').onclick = () => { draft = DRAFT0(); };
    const nb0 = document.getElementById('newB0');
    if (nb0) nb0.onclick = () => { draft = DRAFT0(); };
    $app.querySelectorAll('[data-again]').forEach((b) => b.onclick = () => rebook(list.find((x) => String(x.id) === b.dataset.again)));
    $app.querySelectorAll('[data-keep]').forEach((btn) => btn.onclick = async () => { try { const r = await api('POST', `/api/bookings/${btn.dataset.keep}/ical-keep`, {}); toast(r.message); route(); } catch (e) { toast(e.message); } });
    $app.querySelectorAll('[data-cancel]').forEach((btn) => btn.onclick = async () => { try { const r = await api('POST', `/api/bookings/${btn.dataset.cancel}/cancel`, {}); toast(r.message || 'Ménage annulé.'); route(); } catch (e) { toast(e.message); } });
    $app.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => { sessionStorage.setItem('openEdit', b.dataset.edit); go('#/mes-reservations'); });
    $app.querySelectorAll('[data-rate]').forEach((btn) => btn.onclick = () => pickStars(btn));
    bindThreads([]);
    if (next && next.worker_id) workerCard(next.worker_id).then((h) => { const el = document.getElementById('wcardHost'); if (el) el.innerHTML = h; });
    // le jour du ménage, l'écran se met à jour tout seul toutes les 45 secondes
    clearTimeout(window.__liveTimer);
    if (next && next.date === todayParis() && ['attribuee', 'en_cours'].includes(next.status)) {
      window.__liveTimer = setTimeout(() => { if ((location.hash || '#/') === '#/' && !document.querySelector('.thread textarea:focus')) route(); }, 45000);
    }
  }

  // Avis : on choisit les étoiles, puis on peut ajouter un mot avant d'envoyer
  function pickStars(btn) {
    const box = btn.closest('.stars');
    const id = btn.dataset.rate;
    const n = Number(btn.dataset.stars);
    box.querySelectorAll('[data-rate]').forEach((b) => { b.classList.toggle('on', Number(b.dataset.stars) <= n); b.setAttribute('aria-pressed', Number(b.dataset.stars) === n); });
    let f = box.nextElementSibling && box.nextElementSibling.classList.contains('review-form') ? box.nextElementSibling : null;
    if (!f) {
      f = document.createElement('form');
      f.className = 'review-form stack';
      f.innerHTML = '<label><span class="rv-label"></span><textarea name="review" rows="2" maxlength="500"></textarea></label><label class="check small"><input type="checkbox" name="publish"> J\'accepte que mon avis soit publié sur proprigo.fr, avec mon prénom et l\'initiale de mon nom.</label><button class="btn blue">Envoyer mon avis</button>';
      box.after(f);
    }
    f.querySelector('.rv-label').textContent = n >= 4 ? 'Un mot sur ce que vous avez aimé (facultatif)' : "Qu'est-ce qui n'allait pas ? L'équipe vous recontacte.";
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', `/api/bookings/${id}/rate`, { stars: n, review: f.review.value, publish: f.publish.checked });
        if (n === 5 && CONFIG.googleReviewUrl) {
          f.outerHTML = `<div class="g-review"><b>Merci beaucoup !</b><span>Un avis sur Google aide d'autres familles à nous trouver. Ça prend 30 secondes.</span><a class="btn blue" href="${esc(CONFIG.googleReviewUrl)}" target="_blank" rel="noopener">Laisser un avis sur Google</a></div>`;
          box.remove();
          return;
        }
        toast(r.message || 'Merci pour votre avis.'); route();
      } catch (err) { toast(err.message); }
    };
    f.review.focus({ preventScroll: true });
  }

  // Jauge « ça brille » : avance avec la checklist du ménage
  const SHINE_WORDS = (pct) => (pct >= 100 ? 'Ça brille !' : pct >= 60 ? 'Presque fini' : pct > 0 ? "C'est parti" : 'Prêt à commencer');
  function shine(b) {
    const n = b.checklist.length;
    const d = b.checklist.filter((t) => t.done).length;
    const pct = n ? Math.round((d / n) * 100) : 0;
    return `<div class="shine ${pct >= 100 ? 'full' : ''}" data-shine="${b.id}" role="progressbar" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${d}" aria-label="Tâches faites">
      <div class="shine-top"><b>${SHINE_WORDS(pct)}</b><span>${d} sur ${n}</span></div>
      <div class="shine-bar"><i style="width:${pct}%"></i></div></div>`;
  }
  function updateShine(id) {
    const boxes = [...$app.querySelectorAll(`[data-check="${id}"]`)];
    const el = $app.querySelector(`[data-shine="${id}"]`);
    if (!el) return;
    const d = boxes.filter((c) => c.checked).length;
    const pct = boxes.length ? Math.round((d / boxes.length) * 100) : 0;
    el.querySelector('b').textContent = SHINE_WORDS(pct);
    el.querySelector('span').textContent = `${d} sur ${boxes.length}`;
    el.querySelector('i').style.width = `${pct}%`;
    el.setAttribute('aria-valuenow', d);
    el.classList.toggle('full', pct >= 100);
  }

  // ---------- réservation en 4 étapes ----------
  const STEP_NAMES = ['Ménage', 'Date', 'Résumé', 'Paiement'];
  const STEP_ICONS = ['🧹', '📅', '📋', '💳'];
  const stepper = (n) => `<ol class="stepper" aria-label="Étape ${n} sur 4">${STEP_NAMES.map((t, i) => `<li class="${i + 1 < n ? 'done' : i + 1 === n ? 'now' : ''}" ${i + 1 === n ? 'aria-current="step"' : ''}><span>${i + 1}</span><i class="t-ico" aria-hidden="true">${STEP_ICONS[i]}</i>${t}</li>`).join('')}</ol>`;

  views['reserver'] = async (params) => {
    if (!me) { sessionStorage.setItem('after', `#/reserver${params && params.get('again') ? `?again=${params.get('again')}` : ''}`); return go('#/inscription'); }
    if (me.role !== 'client') return go('#/');
    const [past, homes] = await Promise.all([api('GET', '/api/bookings/mine').catch(() => []), api('GET', '/api/homes').catch(() => [])]);
    const useHome = (h) => {
      draft.home_id = h ? h.id : null;
      if (!h) return;
      Object.assign(draft, { service: h.service, size: h.size || draft.size, hours: h.hours || draft.hours, cp: h.cp, address: h.address, photoConsent: !!h.photo_consent, time: null });
      draft.tasks = h.checklist.map((t) => t.task);
      draft.tasksService = h.service;
    };
    const wanted = sessionStorage.getItem('home');
    if (wanted) { sessionStorage.removeItem('home'); draft = DRAFT0(); useHome(homes.find((h) => String(h.id) === wanted)); }
    // « Réserver le même ménage » (lien des e-mails de relance) : on reprend la prestation passée, sans la date.
    const again = params && past.find((b) => String(b.id) === params.get('again'));
    if (again) {
      draft = DRAFT0();
      Object.assign(draft, { service: again.service, size: again.size || draft.size, hours: again.hours, cp: again.cp, address: again.address, kit: Boolean(again.kit), home_id: again.home_id || null, date: tomorrowParis(), time: null });
      if (again.checklist.length) { draft.tasks = again.checklist.map((t) => t.task); draft.tasksService = again.service; }
      history.replaceState(null, '', '#/reserver');
    }
    const tasks = () => {
      if (draft.tasks && draft.tasksService === draft.service) return draft.tasks;
      const prev = past.find((b) => b.service === draft.service && draft.address && b.address === draft.address && b.checklist.length);
      draft.tasks = prev ? prev.checklist.map((t) => t.task) : [...DEFAULT_TASKS[draft.service]];
      draft.tasksService = draft.service;
      return draft.tasks;
    };
    const quote = () => api('POST', '/api/quote', { service: draft.service, size: draft.size, hours: draft.hours, cp: draft.cp, date: draft.date, time: draft.time, urgent: !!draft.urgent, kit: !!draft.kit, extras: OPTIONABLE.includes(draft.service) ? draft.extras : [], repeat: draft.repeat });
    const shell = (inner, n) => { $app.innerHTML = `<section class="card wizard">${stepper(n)}${inner}</section>`; window.scrollTo(0, 0); };

    // Étape 1 : la prestation
    const step1 = () => {
      const t = tasks();
      shell(`
        <h1>Votre ménage</h1>
        ${homes.length ? `<label>Logement<select id="homeSel"><option value="">Autre adresse</option>${homes.map((h) => `<option value="${h.id}" ${draft.home_id === h.id ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</select></label>` : ''}
        <div class="svc svc4">${['menage', 'grand', 'airbnb', 'bureau'].map((k) => `<button type="button" data-svc="${k}" aria-pressed="${draft.service === k}"><span class="svc-art">${ART.services[k]}</span><b>${SERVICE[k]}</b><span>${SERVICE_HINT[k]}</span></button>`).join('')}</div>
        ${draft.service === 'airbnb'
          ? `<fieldset class="box"><legend>Taille du logement</legend><div class="chips">${Object.keys(SIZE).map((k) => `<button type="button" data-size="${k}" aria-pressed="${draft.size === k}">${SIZE[k]}</button>`).join('')}</div></fieldset>`
          : `<label>Durée<select id="hours">${[2, 2.5, 3, 3.5, 4, 5, 6, 7, 8].map((h) => `<option value="${h}" ${Number(draft.hours) === h ? 'selected' : ''}>${String(h).replace('.', ',')} h</option>`).join('')}</select></label>
             <p class="small muted" style="margin:0">${draft.service === 'bureau' ? 'Repère : environ 1 h pour 80 m² de bureaux (6 à 8 postes), plus les sanitaires et le coin café.' : 'Repère : 2 h pour un studio, 3 h pour un 2 pièces, 4 h pour un 3 pièces.'}</p>
             <label class="check"><input type="checkbox" id="kit" ${draft.kit ? 'checked' : ''}> Je n'ai pas de matériel : l'intervenante apporte aspirateur et produits (+${String(PRICES().kit).replace('.', ',')} €)</label>
             ${draft.service === 'grand' ? `<fieldset class="box"><legend>Fin de bail ?</legend>
               <p class="small muted" style="margin:0 0 8px">Choisissez la taille : la durée et la checklist de l'état des lieux sont réglées pour vous.</p>
               <div class="chips">${Object.entries(LEASE).map(([k, v]) => `<button type="button" data-lease="${k}" aria-pressed="${draft.lease === k}">${v.label} · ${String(v.hours).replace('.', ',')} h</button>`).join('')}</div></fieldset>` : ''}
             ${OPTIONABLE.includes(draft.service) ? `<fieldset class="box"><legend>Options</legend>
               ${Object.entries(EXTRAS).map(([k, v]) => `<label class="check"><input type="checkbox" data-extra="${k}" ${draft.extras.includes(k) ? 'checked' : ''}> <span>${v.label}<br><span class="muted small">+${String(v.hours).replace('.', ',')} h, soit +${eur(v.hours * (draft.service === 'grand' ? PRICES().grand : PRICES().menage))}</span></span></label>`).join('')}
             </fieldset>` : ''}`}
        <details class="box"><summary>Ce qui doit être fait (${t.length} tâches)</summary>
          <div id="tasks">${t.map((x, i) => `<label class="check"><input type="checkbox" data-task="${i}" checked> ${esc(x)}</label>`).join('')}</div>
          <div class="row" style="flex-wrap:nowrap"><input type="text" id="newTask" maxlength="100" placeholder="Ajouter une tâche" aria-label="Ajouter une tâche" style="margin:0"><button type="button" class="btn ghost" id="addTask">Ajouter</button></div>
        </details>
        <label class="check"><input type="checkbox" id="consent" ${draft.photoConsent ? 'checked' : ''}> Photos avant / après (visibles seulement par moi et l'équipe, supprimées après 90 jours)</label>
        <div class="nav2"><a class="btn ghost" href="#/">Annuler</a><button class="btn primary" id="next">Continuer</button></div>`, 1);
      const hs = document.getElementById('homeSel');
      if (hs) hs.onchange = () => { const h = homes.find((x) => String(x.id) === hs.value); if (h) useHome(h); else draft.home_id = null; step1(); };
      $app.querySelectorAll('[data-svc]').forEach((b) => b.onclick = () => { draft.service = b.dataset.svc; if (draft.service === 'airbnb') draft.kit = false; draft.time = null; step1(); });
      $app.querySelectorAll('[data-size]').forEach((b) => b.onclick = () => { draft.size = b.dataset.size; draft.time = null; step1(); });
      $app.querySelectorAll('[data-extra]').forEach((c) => c.onchange = () => { draft.extras = c.checked ? [...new Set([...draft.extras, c.dataset.extra])] : draft.extras.filter((x) => x !== c.dataset.extra); draft.time = null; });
      $app.querySelectorAll('[data-lease]').forEach((b) => b.onclick = () => {
        const l = LEASE[b.dataset.lease];
        draft.lease = b.dataset.lease; draft.hours = l.hours; draft.time = null;
        draft.tasks = [...LEASE_TASKS]; draft.tasksService = 'grand';
        step1(); toast(`Fin de bail ${l.label} : ${String(l.hours).replace('.', ',')} h et checklist de l'état des lieux.`);
      });
      const hr = document.getElementById('hours');
      if (hr) hr.onchange = () => { draft.hours = Number(hr.value); draft.time = null; };
      const kit = document.getElementById('kit');
      if (kit) kit.onchange = () => { draft.kit = kit.checked; };
      document.getElementById('consent').onchange = (e) => { draft.photoConsent = e.target.checked; };
      $app.querySelectorAll('[data-task]').forEach((c) => c.onchange = () => { if (!c.checked) { draft.tasks.splice(Number(c.dataset.task), 1); step1(); $app.querySelector('details').open = true; } });
      document.getElementById('addTask').onclick = () => { const v = document.getElementById('newTask').value.trim(); if (v.length >= 3) { draft.tasks.push(v); step1(); $app.querySelector('details').open = true; } };
      document.getElementById('next').onclick = () => { draft.step = 2; render(); };
    };

    // Étape 2 : date, heure et adresse
    const step2 = async () => {
      shell(`
        <h1>Date et heure</h1>
        <div class="grid2" style="gap:12px">
          <label>Code postal<input type="text" id="cp" inputmode="numeric" maxlength="5" autocomplete="postal-code" value="${esc(draft.cp)}" required></label>
          <label>Date<input type="date" id="date" min="${todayParis()}" value="${esc(draft.date)}" required></label>
        </div>
        <label>Adresse<input type="text" id="address" autocomplete="street-address" value="${esc(draft.address)}" placeholder="Numéro, rue, étage, code d'accès" required></label>
        <fieldset class="box" id="whoBox" hidden></fieldset>
        <fieldset class="box"><legend>Heure d'arrivée</legend><div id="slots"><p class="muted small">Chargement des créneaux proposés…</p></div><div id="prefNote"></div></fieldset>
        ${draft.date === todayParis() ? `<label class="check"><input type="checkbox" id="urgent" ${draft.urgent ? 'checked' : ''}> Urgence : arrivée dans les 3 prochaines heures (+25 %)</label>` : ''}
        <fieldset class="box"><legend>Fréquence</legend>
          <div class="chips">${[['0', 'Une seule fois'], ['7', `Chaque semaine · −${Math.round(PRICES().subscription * 100)} %`], ['14', `Toutes les 2 semaines · −${Math.round(PRICES().subscription * 100)} %`]].map(([v, l]) => `<button type="button" data-repeat="${v}" aria-pressed="${draft.repeat === v}">${l}</button>`).join('')}</div>
          ${draft.repeat !== '0' ? `<label>Nombre de ménages réservés d'avance<select id="occ">${[4, 8, 12].map((n) => `<option ${Number(draft.occurrences) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label><p class="small muted" style="margin:0">Même intervenante chaque fois que possible. Vous pouvez arrêter à tout moment.</p>` : ''}
        </fieldset>
        <p class="err" id="err2"></p>
        <div class="nav2"><button class="btn ghost" id="back">Retour</button><button class="btn primary" id="next">Continuer</button></div>`, 2);
      const save = () => { draft.cp = document.getElementById('cp').value.trim(); draft.address = document.getElementById('address').value.trim(); };
      document.getElementById('back').onclick = () => { save(); draft.step = 1; render(); };
      document.getElementById('cp').onchange = () => { save(); draft.time = null; setTimeout(step2, 0); };
      document.getElementById('date').onchange = (e) => { save(); draft.date = e.target.value; draft.time = null; draft.urgent = false; setTimeout(step2, 0); };
      document.getElementById('address').onchange = save;
      const urg = document.getElementById('urgent');
      if (urg) urg.onchange = () => { draft.urgent = urg.checked; };
      $app.querySelectorAll('[data-repeat]').forEach((b) => b.onclick = () => { save(); draft.repeat = b.dataset.repeat; if (draft.repeat !== '0') draft.urgent = false; step2(); });
      const occ = document.getElementById('occ');
      if (occ) occ.onchange = () => { draft.occurrences = Number(occ.value); };
      const box = document.getElementById('slots');
      const pref = document.getElementById('prefNote');
      let r = { slots: [], preferred: null };
      // « avec qui ? » : une intervenante déjà venue chez le client, ou peu importe
      const whoBox = document.getElementById('whoBox');
      const mwr = me && me.role === 'client' ? await api('GET', '/api/my-workers').catch(() => null) : null;
      if (mwr && mwr.list.length && whoBox) {
        if (draft.want === undefined) draft.want = mwr.favorite || mwr.list[0].id;
        whoBox.hidden = false;
        whoBox.innerHTML = `<legend>Avec qui ?</legend><div class="who-pick">${mwr.list.map((w) => `<button type="button" data-want="${w.id}" aria-pressed="${draft.want === w.id}">${avatar(w.id, w.photo, w.name, 'sm')}<span><b>${esc(w.name)}</b>${mwr.favorite === w.id ? ' ★' : ''}<small>${w.n} ménage${w.n > 1 ? 's' : ''} chez vous</small></span></button>`).join('')}
          <button type="button" data-want="" aria-pressed="${!draft.want}"><span class="av sm" aria-hidden="true">👥</span><span><b>Peu importe</b><small>La première disponible</small></span></button></div>`;
        whoBox.querySelectorAll('[data-want]').forEach((b) => b.onclick = () => { save(); draft.want = b.dataset.want ? Number(b.dataset.want) : null; draft.time = null; step2(); });
      }
      if (/^\d{5}$/.test(draft.cp)) {
        r = await api('GET', `/api/slots?date=${encodeURIComponent(draft.date)}&cp=${encodeURIComponent(draft.cp)}&hours=${draftHours(draft)}&service=${draft.service}${draft.home_id ? `&home_id=${draft.home_id}` : ''}${draft.want ? `&worker_id=${draft.want}` : ''}`);
        if (draft.want === null) r.preferred = null;
        if (draft.time && !r.slots.includes(draft.time)) draft.time = null;
        const paintSlots = () => {
          const p = r.preferred;
          box.innerHTML = r.slots.length
            ? `<div class="chips times">${r.slots.map((t) => `<button type="button" data-time="${t}" aria-pressed="${draft.time === t}">${t}${p && p.slots.includes(t) ? ' ★' : ''}</button>`).join('')}</div>
               ${p ? `<p class="small muted" style="margin:6px 0 0">★ ${esc(p.name)} est actuellement disponible à ces heures (sous réserve de confirmation).</p>` : ''}`
            : '<p class="msg warn">Aucun créneau proposé pour cette date. Essayez une autre date.</p>';
          pref.innerHTML = p && draft.time && !p.slots.includes(draft.time) ? `<p class="notice"><b>${esc(p.name)} n'est pas libre à ${esc(draft.time)}.</b> L'équipe recherchera une intervenante et vous confirmera son attribution.${p.slots.length ? ` Choisissez une heure marquée ★ pour l'avoir.` : ` Elle n'est pas libre ce jour-là.`}</p>` : '';
          box.querySelectorAll('[data-time]').forEach((b) => b.onclick = () => { draft.time = b.dataset.time; paintSlots(); });
        };
        paintSlots();
      } else box.innerHTML = '<p class="msg">Entrez le code postal pour voir les créneaux proposés.</p>';
      document.getElementById('next').onclick = async () => {
        save();
        const err = document.getElementById('err2');
        if (draft.address.length < 5) { err.textContent = "Indiquez l'adresse complète."; return; }
        if (!draft.time) { err.textContent = 'Choisissez une heure d\'arrivée.'; return; }
        const q = await quote();
        if (!q.ok) { err.textContent = q.errors.join(' '); return; }
        if (!q.open) { err.textContent = `Proprigo n'est pas encore ouvert au ${draft.cp}.`; return; }
        draft.step = 3; render();
      };
    };

    // Étape 3 : récapitulatif
    const step3 = async () => {
      const q = await quote();
      const n = draft.repeat !== '0' ? Number(draft.occurrences) : 1;
      let who = 'Une intervenante vérifiée, confirmée par e-mail';
      try {
        const s = await api('GET', `/api/slots?date=${draft.date}&cp=${draft.cp}&hours=${draftHours(draft)}&service=${draft.service}${draft.home_id ? `&home_id=${draft.home_id}` : ''}`);
        if (s.preferred && s.preferred.slots.includes(draft.time)) who = `${s.preferred.name}, votre intervenante préférée`;
      } catch { /* sans incidence */ }
      shell(`
        <h1>Récapitulatif</h1>
        <dl class="facts">
          <div><dt>Prestation</dt><dd>${draft.service === 'airbnb' ? `Ménage Airbnb ${SIZE[draft.size]} (ménage + linge)` : `${SERVICE[draft.service]} ${String(draft.hours).replace('.', ',')} h`}${draft.kit ? ', matériel fourni' : ''} <button class="link" data-goto="1">Modifier</button>${OPTIONABLE.includes(draft.service) && draft.extras.length ? `<br><span class="muted small">Options : ${draft.extras.map((k) => EXTRAS[k].label.toLowerCase()).join(', ')}</span>` : ''}</dd></div>
          <div><dt>Date</dt><dd>${esc(dateLong(draft.date))} à ${esc(draft.time)}${n > 1 ? `, puis ${draft.repeat === '7' ? 'chaque semaine' : 'toutes les 2 semaines'} (${n} ménages)` : ''} <button class="link" data-goto="2">Modifier</button></dd></div>
          <div><dt>Adresse</dt><dd>${esc(draft.address)}, ${esc(draft.cp)}</dd></div>
          <div><dt>Intervenante</dt><dd>${esc(who)}</dd></div>
          <div><dt>À faire</dt><dd>${draft.tasks.length} tâches${draft.photoConsent ? ', photos avant / après' : ''}</dd></div>
        </dl>
        ${q.ok ? `<div class="price">
          <div class="row"><span>Total${CONFIG.franchiseTVA ? '' : ' TTC'}${n > 1 ? ' du premier ménage' : ''}</span><span class="total">${eur(q.total)}</span></div>
          ${q.lines.map((l) => `<div class="line"><span>${esc(l.label)}</span><span>${eur(l.amount)}</span></div>`).join('')}
          ${!PRO.includes(q.service) ? (sapOn() ? `<div class="line"><span>Après crédit d'impôt de 50 %*</span><span>${eur(q.total / 2)}</span></div>` : '') : CONFIG.franchiseTVA ? '<div class="line"><span>TVA non applicable (art. 293 B du CGI)</span><span></span></div>' : `<div class="line"><span>Dont TVA 20 %</span><span>${eur(q.total - q.total / 1.2)}</span></div>`}
        </div>
        ${n > 1 ? '<p class="small muted">Chaque ménage est facturé à son prix (supplément le dimanche ou un jour férié).</p>' : ''}
        ${!PRO.includes(q.service) && sapOn() ? '<p class="small muted">* Crédit d\'impôt pour l\'emploi d\'un salarié à domicile (article 199 sexdecies du CGI), selon les conditions en vigueur. Attestation annuelle fournie.</p>' : ''}` : `<p class="err">${q.errors.map(esc).join(' ')}</p>`}
        <p class="box small">${FREE_CANCEL} Vous pouvez modifier la date ou l'heure jusqu'à 24 h avant.</p>
        <div class="nav2"><button class="btn ghost" id="back">Retour</button><button class="btn primary" id="next" ${q.ok ? '' : 'disabled'}>Continuer vers le paiement</button></div>`, 3);
      $app.querySelectorAll('[data-goto]').forEach((b) => b.onclick = () => { draft.step = Number(b.dataset.goto); render(); });
      document.getElementById('back').onclick = () => { draft.step = 2; render(); };
      document.getElementById('next').onclick = () => { draft.step = 4; render(); };
    };

    // Étape 4 : confirmation et paiement
    const step4 = async () => {
      const q = await quote();
      shell(`
        <h1>Paiement</h1>
        <div class="box stack">
          <p style="margin:0"><b>${eur(q.total)}</b> pour le ménage du ${esc(dateLong(draft.date))} à ${esc(draft.time)}.</p>
          ${draft.repeat !== '0' ? `<label>Mode de paiement<select id="payment_mode"><option value="all" ${draft.payment_mode === 'all' ? 'selected' : ''}>Toutes les interventions maintenant</option><option value="per_visit" ${draft.payment_mode === 'per_visit' ? 'selected' : ''}>Chaque intervention avant sa réalisation</option></select></label>` : ''}
          <p class="notice" style="margin:0">Paiement sécurisé via Stripe. Aucune intervention ne démarre sans paiement confirmé.</p>
        </div>
        <label class="check"><input type="checkbox" id="cgv" ${draft.cgv ? 'checked' : ''}> J'accepte les <a href="#/cgv" target="_blank" rel="noopener">conditions générales de vente</a> et la <a href="#/confidentialite" target="_blank" rel="noopener">politique de confidentialité</a>.</label>
        <p class="err" id="err4"></p>
        <div class="nav2"><button class="btn ghost" id="back">Retour</button><button class="btn primary" id="pay">${q.total > 0 ? `💳 Payer ${eur(q.total)}` : '✅ Confirmer : réglé par mon crédit'}</button></div>`, 4);
      const modeInput = document.getElementById('payment_mode');
      if (modeInput) modeInput.onchange = (e) => { draft.payment_mode = e.target.value; };
      document.getElementById('cgv').onchange = (e) => { draft.cgv = e.target.checked; };
      document.getElementById('back').onclick = () => { draft.step = 3; render(); };
      document.getElementById('pay').onclick = async (e) => {
        if (!draft.cgv) { document.getElementById('err4').textContent = 'Merci d\'accepter les conditions générales.'; return; }
        e.target.disabled = true;
        try {
          const r = await api('POST', '/api/bookings', { ...draft, urgent: !!draft.urgent, kit: !!draft.kit, checklist: draft.tasks, home_id: draft.home_id || undefined, want_worker_id: draft.want || undefined });
          if (r.checkout_url) { window.location.assign(r.checkout_url); return; }
          if (r.paidByCredit) toast('Réglé avec votre crédit Proprigo : rien à payer.');
          $app.innerHTML = `<section class="card wizard done-card">
            <div class="done-art">${ART.done}</div>
            <h1>C'est réservé !</h1>
            <p>${esc(dateLong(r.date))} à ${esc(r.time)}, ${esc(r.address)}.</p>
            <p>${r.worker_name ? `<b>${esc(r.worker_name.split(' ')[0])}</b>, intervenante vérifiée, viendra.` : 'Nous confirmons votre intervenante très vite.'}${r.created > 1 ? ` ${r.created} ménages sont réservés.` : ''}</p>
            <p class="small muted">Un e-mail de confirmation vous est envoyé.</p>
            <a class="btn primary" href="#/">Suivre ma réservation</a></section>`;
          draft = DRAFT0();
        } catch (err) { document.getElementById('err4').textContent = err.message; e.target.disabled = false; }
      };
    };

    const render = () => ({ 1: step1, 2: step2, 3: step3, 4: step4 }[draft.step] || step1)();
    render();
  };
  // ---------- comptes ----------
  views['connexion'] = () => {
    $app.innerHTML = `
      <section class="card stack" style="max-width:460px;margin:auto">
        <h1>Se connecter</h1>
        <form id="f" class="stack">
          <label>E-mail<input type="email" name="email" autocomplete="email" required></label>
          <label>Mot de passe<input type="password" name="password" autocomplete="current-password" required></label>
          <p class="small" style="margin:4px 0 0;text-align:right"><a href="#/mot-de-passe-oublie">Mot de passe oublié ?</a></p>
          <button class="btn primary full">Se connecter</button>
        </form>
        <p class="small">Pas encore de compte ? <a href="#/inscription">Créer un compte client</a> · <a href="#/inscription-intervenante">Travailler avec nous</a></p>
      </section>`;
    document.getElementById('f').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/api/login', formData(e.target));
        await loadMe();
        go(r.role === 'admin' ? '#/admin' : r.role === 'intervenante' ? '#/intervenante' : (sessionStorage.getItem('after') || '#/'));
        sessionStorage.removeItem('after');
      } catch (err) { toast(err.message); }
    };
  };

  function signup(role, params) {
    const worker = role === 'intervenante';
    const ref = params && params.get('ref') ? params.get('ref').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) : (sessionStorage.getItem('ref') || '');
    if (params && params.get('cadeau')) sessionStorage.setItem('cadeau', params.get('cadeau').slice(0, 20));
    if (ref) sessionStorage.setItem('ref', ref);
    $app.innerHTML = `
      <section class="card stack" style="max-width:520px;margin:auto">
        <h1>${worker ? 'Travailler avec Proprigo' : 'Créer un compte'}</h1>
        ${worker ? '<p class="muted">Après votre inscription, notre équipe vous contacte pour la suite : vérification de l\'identité, entretien, formation. Vous recevrez des missions une fois votre compte activé.</p>' : ''}
        <form id="f" class="stack">
          <label>Prénom et nom<input type="text" name="name" autocomplete="name" required></label>
          <label>E-mail<input type="email" name="email" autocomplete="email" required></label>
          <label>Téléphone<input type="tel" name="phone" autocomplete="tel"></label>
          <label>Mot de passe (10 caractères minimum)<input type="password" name="password" autocomplete="new-password" minlength="10" required></label>
          ${worker ? '' : `<label>Code de parrainage (facultatif)<input type="text" name="ref" maxlength="12" autocapitalize="characters" value="${esc(ref)}" placeholder="Ex. CLAIRE123"></label>${ref ? '<p class="msg ok" style="margin:0">10 € offerts sur votre premier ménage.</p>' : ''}`}
          ${worker ? `
            <label>Code postal de votre domicile<input type="text" name="cp" inputmode="numeric" maxlength="5" required></label>
            <label>Vous souhaitez travailler comme
              <select name="statut" id="statut"><option value="S">Salariée de Proprigo</option><option value="I">Indépendante (auto-entrepreneuse)</option></select></label>
            <label id="rateBox" hidden>Votre tarif horaire, facturé à Proprigo<input type="number" name="rate" min="15" max="40" step="0.5" value="22"></label>` : ''}
          <p class="small muted">Nous ne demandons que ces informations pour l'instant. Les autres documents ne seront demandés qu'aux étapes qui en ont besoin.</p>
          <button class="btn primary full">Créer mon compte</button>
        </form>
      </section>`;
    const st = document.getElementById('statut');
    if (st) st.onchange = () => { document.getElementById('rateBox').hidden = st.value !== 'I'; };
    document.getElementById('f').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/signup', { ...formData(e.target), role });
        sessionStorage.removeItem('ref');
        await loadMe();
        const gift = sessionStorage.getItem('cadeau');
        if (gift && !worker) { sessionStorage.removeItem('cadeau'); try { const g = await api('POST', '/api/gifts/redeem', { code: gift }); toast(g.message); } catch (err) { toast(err.message); } }
        go(worker ? '#/intervenante' : (sessionStorage.getItem('after') || '#/reserver'));
        sessionStorage.removeItem('after');
      } catch (err) { toast(err.message); }
    };
  }
  views['inscription'] = (p) => signup('client', p);
  views['inscription-intervenante'] = (p) => signup('intervenante', p);

  const REPEAT = { 7: 'Chaque semaine', 14: 'Toutes les 2 semaines' };
  views['mes-reservations'] = async () => {
    if (!me || me.role !== 'client') return go('#/connexion');
    const list = await api('GET', '/api/bookings/mine');
    const mw = await api('GET', '/api/my-workers');
    const series = {};
    const isHistory = (b) => ['annulee', 'terminee'].includes(b.status);
    const visibleBookings = [...list].sort((a, b) => Number(b.id) - Number(a.id));
    const hoursLeft = (b) => (Date.parse(`${b.date}T${b.time}:00`) - Date.now()) / 36e5;
    const renderBooking = (b) => {
        const active = ['en_attente', 'proposee', 'attribuee'].includes(b.status);
        const showStop = b.series_id && active && !series[b.series_id];
        if (b.series_id) series[b.series_id] = true;
        return `
        <article class="card">
          <div class="row"><h3>${esc(label(b))}${b.series_id ? ' <span class="pill">Récurrent</span>' : ''}</h3>${pill(b.status)}</div>
          <p class="muted" style="margin:6px 0 0">${dateFr(b.date)} à ${esc(b.time)} · ${esc(b.address)} · ${esc(b.cp)} · <b>${b.payment_status === 'garantie' ? 'Gratuit (garantie)' : eur(b.total)}</b>${b.kit ? ' · matériel fourni' : ''}</p>
          ${b.payment_status === 'garantie' ? '<p class="small" style="margin:6px 0 0"><span class="pill ok">Retour gratuit</span> Nous revenons reprendre les points que vous avez signalés.</p>' : ''}
          ${b.status === 'attribuee' && b.on_way_at && !b.arrived_at ? `<p class="live-line"><span class="live-dot"></span>${esc((b.worker_name || '').split(' ')[0])} est en route${b.eta_at ? `, arrivée estimée vers ${hhmm(b.eta_at)}` : ''}.</p>` : ''}
          ${b.worker_name ? `<p class="who-line">${avatar(b.worker_id, b.worker_photo, b.worker_name, 'sm')}<span>Intervenante vérifiée : <b>${esc(b.worker_name)}</b></span>${mw.favorite === b.worker_id ? ' <span class="pill ok">★ Votre préférée</span>' : ''}</p>` : ''}
          ${b.source === 'ical' ? '<p class="small muted" style="margin:6px 0 0">Créé automatiquement depuis le calendrier de votre annonce.</p>' : ''}
          ${b.ical_flagged && ['en_attente', 'proposee', 'attribuee'].includes(b.status) ? `<div class="notice"><b>Ce séjour n'apparaît plus dans le calendrier de votre annonce.</b> Le ménage reste prévu. Si le séjour est bien annulé, annulez le ménage ; sinon, gardez-le.<div class="actions"><button class="btn ghost" data-keep="${b.id}">Garder le ménage</button><button class="btn ghost" data-cancel="${b.id}">Annuler le ménage</button></div></div>` : ''}
          <p class="small muted" style="margin:6px 0 0">${esc(paymentLabel(b))}</p>
          ${b.status === 'terminee' && b.worker_id && mw.favorite !== b.worker_id ? `<p style="margin:8px 0 0"><button class="btn ghost" data-fav="${b.worker_id}">★ Garder ${esc(b.worker_name.split(' ')[0])} pour mes prochains ménages</button></p>` : ''}
          ${b.checklist.length && (b.status === 'en_cours' || (b.status === 'terminee' && b.checklist.some((t) => t.done))) ? shine(b) : ''}${b.checklist.length ? `<details><summary>${b.status === 'terminee' && !b.checklist.some((t) => t.done) ? `Ce qui était prévu (${b.checklist.length} tâches)` : `Ce qui doit être fait (${b.checklist.filter((t) => t.done).length}/${b.checklist.length} fait)`}</summary><ul class="tasks">${b.checklist.map((t) => `<li class="${t.done ? 'done' : ''}">${t.done ? '✓' : '○'} ${esc(t.task)}</li>`).join('')}</ul></details>` : ''}
          ${b.photos.length ? `<div class="photos">${b.photos.map((p) => `<figure><img src="/api/photos/${p.id}" alt="Photo ${p.kind === 'avant' ? 'avant' : 'après'} le ménage" loading="lazy"><figcaption>${p.kind === 'avant' ? 'Avant' : 'Après'}</figcaption></figure>`).join('')}</div>` : ''}
          ${b.status === 'terminee' && b.worker_id ? (b.tip ? `<p class="tip-done">💝 Merci ! Pourboire de ${eur(b.tip)} envoyé à ${esc((b.worker_name || '').split(' ')[0])}.</p>`
            : b.date >= addDaysFront(todayParis(), -30) ? `<details class="tip-box"><summary>💝 Laisser un pourboire à ${esc((b.worker_name || '').split(' ')[0])}</summary>
              <p class="small muted" style="margin:6px 0 8px">Il lui est reversé en entier.</p>
              <div class="chips">${[2, 5, 10].map((n) => `<button type="button" data-tip="${b.id}" data-amount="${n}">${n} €</button>`).join('')}
              <button type="button" data-tip="${b.id}" data-amount="other">Autre</button></div></details>` : '') : ''}
          <div class="bk-main">
            ${b.status !== 'annulee' ? `<button class="btn ghost" data-thread="${b.id}">💬 Messages${b.messages ? ` (${b.messages})` : ''}</button>` : ''}
            ${b.paid || b.status === 'terminee' ? `<a class="btn ghost" href="/api/bookings/${b.id}/receipt" target="_blank" rel="noopener">🧾 Facture</a>` : ''}
            ${['en_cours', 'terminee'].includes(b.status) ? `<button class="btn ghost" data-report="${b.id}">⚠️ Signaler un problème</button>` : ''}
          </div>
          ${active || showStop ? `<div class="bk-more">
            ${active && hoursLeft(b) >= 24 ? `<button type="button" class="linkish" data-edit="${b.id}">Modifier la date ou l'heure</button>` : ''}
            ${showStop ? `<button type="button" class="linkish" data-stop="${b.series_id}">Arrêter la récurrence</button>` : ''}
            ${active ? `<button type="button" class="linkish danger-link" data-cancel="${b.id}">Annuler le ménage</button>` : ''}
          </div>` : ''}
          ${active && hoursLeft(b) < 24 ? '<p class="small muted" style="margin:6px 0 0">Ménage dans moins de 24 h : pour un changement, écrivez-nous dans les messages. En cas d\'annulation, la moitié du prix est retenue.</p>' : ''}
          ${active && b.preferred_id && b.worker_id !== b.preferred_id ? `<div class="notice"><b>${esc(b.preferred_name)}, votre intervenante préférée, n'est pas disponible à ce créneau.</b> Une autre intervenante vérifiée Proprigo viendra à sa place.
            ${hoursLeft(b) >= 24 ? `<br>Vous préférez ${esc(b.preferred_name)} ? <button class="btn ghost" data-prefslots="${b.id}">Voir quand ${esc(b.preferred_name)} est libre</button><div id="pref-${b.id}"></div>` : ''}</div>` : ''}
          <div id="edit-${b.id}"></div><div id="report-${b.id}"></div><div id="thread-${b.id}"></div>
          ${b.guarantee_status === 'demandee' ? '<div class="notice"><b>Retour gratuit demandé.</b> L\'équipe vous contacte pour fixer le créneau.</div>' : ''}
          ${b.guarantee_status === 'planifiee' ? `<div class="notice"><b>Retour gratuit planifié</b> (réservation n° ${b.guarantee_visit_id}, ci-dessus).</div>` : ''}
          ${b.guarantee_open ? `<div class="guarantee"><span><b>Pas satisfait ?</b> Dites-le-nous dans les 48 h : on revient gratuitement.</span><button class="btn ghost" data-guarantee="${b.id}">On revient</button></div><div id="guar-${b.id}"></div>` : ''}
          ${b.status === 'terminee' && !b.rating ? `<p style="margin:10px 0 0"><b>Comment s'est passé le ménage ?</b></p><div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-rate="${b.id}" data-stars="${n}" aria-label="${n} sur 5">★</button>`).join('')}</div>` : ''}
          ${b.rating ? `<p class="small muted" style="margin:8px 0 0">Votre note : ${'★'.repeat(b.rating)}</p>` : ''}
          ${active && b.payment_status === 'en_attente_paiement' ? `<button class="btn primary" data-pay-booking="${b.id}">💳 Payer cette intervention</button>` : ''}
        </article>`;
    };
    $app.innerHTML = `
      <div class="row"><h1>Mes réservations</h1><a class="btn primary" href="#/reserver">Nouvelle réservation</a></div>
      <p class="small muted">${FREE_CANCEL}</p>
      ${list.length ? '' : '<p class="card muted">Aucune réservation pour le moment.</p>'}
      ${visibleBookings.some((b) => !isHistory(b)) ? '<h2>Réservations en cours</h2>' : ''}
      ${visibleBookings.filter((b) => !isHistory(b)).map((b) => renderBooking(b)).join('')}
      ${visibleBookings.some(isHistory) ? '<h2>Historique</h2>' : ''}
      ${visibleBookings.filter(isHistory).map((b) => renderBooking(b)).join('')}`;

    const act = (sel, fn) => $app.querySelectorAll(sel).forEach((btn) => btn.onclick = () => fn(btn));
    act('[data-prefslots]', async (btn) => {
      const id = btn.dataset.prefslots;
      const box = document.getElementById(`pref-${id}`);
      if (box.innerHTML) { box.innerHTML = ''; return; }
      try {
        const r = await api('GET', `/api/bookings/${id}/preferred-slots`);
        box.innerHTML = r.options.length
          ? `<p class="small" style="margin:8px 0 0">Créneaux où ${esc(r.name)} est libre :</p><div class="chips">${r.options.map((o) => `<button type="button" data-move="${id}" data-date="${o.date}" data-time="${o.time}">${dateFr(o.date)} ${o.time} · ${eur(o.total)}</button>`).join('')}</div>`
          : `<p class="small muted">${esc(r.name)} n'a pas de créneau libre dans les 14 prochains jours.</p>`;
        box.querySelectorAll('[data-move]').forEach((m) => m.onclick = async () => {
          try { const u = await api('POST', `/api/bookings/${m.dataset.move}/update`, { date: m.dataset.date, time: m.dataset.time }); toast(u.message); route(); } catch (e) { toast(e.message); }
        });
      } catch (e) { toast(e.message); }
    });
    act('[data-guarantee]', (btn) => {
      const id = btn.dataset.guarantee;
      const box = document.getElementById(`guar-${id}`);
      if (box.innerHTML) { box.innerHTML = ''; return; }
      box.innerHTML = `<form class="box stack"><label>Qu'est-ce qui n'allait pas ? (pièces, tâches oubliées…)<textarea name="text" rows="3" maxlength="800" required minlength="10" placeholder="Ex. la salle de bain n'a pas été faite, traces sur les vitres du salon"></textarea></label>
        <button class="btn primary">Demander le retour gratuit</button></form>`;
      box.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        try { const r = await api('POST', `/api/bookings/${id}/guarantee`, { text: e.target.text.value }); toast(r.message); route(); } catch (err) { toast(err.message); }
      };
      box.querySelector('textarea').focus();
    });
    act('[data-tip]', async (btn) => {
      let n = btn.dataset.amount;
      if (n === 'other') { n = prompt('Montant du pourboire, en euros (1 à 50) :', '3'); if (n === null) return; }
      n = Math.round(Number(String(n).replace(',', '.')));
      if (!(n >= 1 && n <= 50)) { toast('Choisissez un montant entre 1 et 50 €.'); return; }
      try { const r = await api('POST', `/api/bookings/${btn.dataset.tip}/tip`, { amount: n }); if (r.url) location.href = r.url; else { toast(r.message); route(); } } catch (e) { toast(e.message); }
    });
    act('[data-fav]', async (btn) => { try { const r = await api('POST', '/api/favorite', { worker_id: Number(btn.dataset.fav) }); toast(r.message); route(); } catch (e) { toast(e.message); } });
    $app.querySelectorAll('[data-keep]').forEach((btn) => btn.onclick = async () => { try { const r = await api('POST', `/api/bookings/${btn.dataset.keep}/ical-keep`, {}); toast(r.message); route(); } catch (e) { toast(e.message); } });
    act('[data-pay-booking]', async (btn) => { try { const r = await api('POST', `/api/bookings/${btn.dataset.payBooking}/pay`, {}); window.location.assign(r.checkout_url); } catch (e) { toast(e.message); } });
    act('[data-cancel]', async (btn) => {
      const b = list.find((x) => String(x.id) === btn.dataset.cancel);
      const retained = b && hoursLeft(b) < 24 ? Number(b.total) * 0.5 : 0;
      const refund = b && b.paid ? Math.max(0, Number(b.total) - retained) : 0;
      if (!confirm(retained ? `Annuler ce ménage ?\n\nIl a lieu dans moins de 24 h : ${eur(retained)} sont retenus.\nVous serez remboursé de ${eur(refund)}.` : `Annuler ce ménage ?\n\nL'annulation est gratuite${refund ? ` : vous serez remboursé de ${eur(refund)}` : ''}.`)) return;
      try { const r = await api('POST', `/api/bookings/${btn.dataset.cancel}/cancel`, {}); toast(r.message || 'Réservation annulée.'); route(); } catch (e) { toast(e.message); } });
    act('[data-stop]', async (btn) => { try { const r = await api('POST', `/api/series/${btn.dataset.stop}/stop`, {}); toast(r.message); route(); } catch (e) { toast(e.message); } });
    $app.querySelectorAll('[data-rate]').forEach((btn) => btn.onclick = () => pickStars(btn));
    act('[data-edit]', (btn) => {
      const b = list.find((x) => String(x.id) === btn.dataset.edit);
      const box = document.getElementById(`edit-${b.id}`);
      if (box.innerHTML) { box.innerHTML = ''; return; }
      box.innerHTML = `<form class="box stack">
        <div class="grid2" style="gap:12px"><label>Date<input type="date" name="date" value="${b.date}" min="${tomorrowParis()}" required></label>
        <label>Heure<select name="time">${HALF_HOURS.map((t) => `<option ${t === b.time ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
        ${b.service !== 'airbnb' ? `<label>Durée<select name="hours">${[2, 2.5, 3, 3.5, 4, 5, 6, 7, 8].map((h) => `<option value="${h}" ${b.hours === h ? 'selected' : ''}>${String(h).replace('.', ',')} h</option>`).join('')}</select></label>` : ''}
        <label>Adresse<input type="text" name="address" value="${esc(b.address)}" required></label>
        <p class="small muted">Le prix est recalculé et la disponibilité vérifiée avant d'enregistrer.</p>
        <button class="btn blue">Enregistrer la modification</button></form>`;
      box.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        try { const r = await api('POST', `/api/bookings/${b.id}/update`, formData(e.target)); toast(r.message); route(); } catch (err) { toast(err.message); }
      };
    });
    act('[data-report]', (btn) => {
      const box = document.getElementById(`report-${btn.dataset.report}`);
      if (box.innerHTML) { box.innerHTML = ''; return; }
      box.innerHTML = `<form class="box stack"><label>Quel est le problème ?<textarea name="text" rows="3" maxlength="1000" required></textarea></label><button class="btn blue">Envoyer à l'équipe qualité</button></form>`;
      box.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        try { const r = await api('POST', `/api/bookings/${btn.dataset.report}/report`, formData(e.target)); toast(r.message); box.innerHTML = ''; } catch (err) { toast(err.message); }
      };
    });
    bindThreads([]);
    const open = sessionStorage.getItem('openEdit');
    if (open) {
      sessionStorage.removeItem('openEdit');
      const btn = $app.querySelector(`[data-edit="${open}"]`);
      if (btn) { btn.click(); btn.scrollIntoView({ block: 'center' }); }
    }
  };

  // ---------- espace propriétaires ----------
  function homeForm(h = {}, workers = []) {
    const service = h.service || 'airbnb';
    return `<form class="stack" data-home="${h.id || ''}">
      <div class="grid2" style="gap:12px"><label>Nom du logement<input type="text" name="name" value="${esc(h.name || '')}" placeholder="Studio Montmartre" required></label>
      <label>Code postal<input type="text" name="cp" inputmode="numeric" maxlength="5" value="${esc(h.cp || '')}" required></label></div>
      <label>Adresse<input type="text" name="address" value="${esc(h.address || '')}" placeholder="Numéro, rue, étage" required></label>
      <div class="grid2" style="gap:12px">
        <label>Type de ménage<select name="service">${['airbnb', 'menage', 'grand', 'bureau'].map((k) => `<option value="${k}" ${service === k ? 'selected' : ''}>${SERVICE[k]}</option>`).join('')}</select></label>
        <label>Taille (Airbnb)<select name="size">${Object.keys(SIZE).map((k) => `<option value="${k}" ${(h.size || 'T2') === k ? 'selected' : ''}>${SIZE[k]}</option>`).join('')}</select></label>
        <label>Durée (ménage à l'heure)<select name="hours">${[2, 2.5, 3, 3.5, 4, 5, 6].map((x) => `<option value="${x}" ${(h.hours || 3) === x ? 'selected' : ''}>${String(x).replace('.', ',')} h</option>`).join('')}</select></label>
        <label>Heure de départ des voyageurs<select name="checkout_time">${HALF_HOURS.map((t) => `<option ${(h.checkout_time || '11:00') === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      </div>
      <label>Consignes pour l'intervenante<textarea name="instructions" rows="3" maxlength="1000" placeholder="Accès, boîte à clés, où sont les draps, poubelles…">${esc(h.instructions || '')}</textarea></label>
      <p class="small muted" style="margin:0">Les consignes ne sont visibles que par l'intervenante qui a la mission. Évitez d'y écrire un code d'alarme.</p>
      <label>Checklist (une tâche par ligne)<textarea name="checklist" rows="5">${esc((h.checklist && h.checklist.length ? h.checklist.map((t) => t.task) : DEFAULT_TASKS[service]).join('\n'))}</textarea></label>
      <label class="check"><input type="checkbox" name="photo_consent" ${h.photo_consent ? 'checked' : ''}> Photos avant / après pour ce logement (visibles par moi et l'équipe, supprimées après 90 jours)</label>
      ${h.id ? `<label>Intervenante préférée pour ce logement<select name="preferred_worker_id"><option value="">Pas de préférence</option>${workers.map((w) => `<option value="${w.id}" ${h.preferred_worker_id === w.id ? 'selected' : ''}>${esc(w.name)} (${w.n} ménage${w.n > 1 ? 's' : ''})</option>`).join('')}</select></label>` : ''}
      <label>Lien du calendrier de l'annonce (iCal, facultatif)<input type="url" name="ical_url" value="${esc(h.ical_url || '')}" placeholder="https://www.airbnb.fr/calendar/ical/….ics"></label>
      <p class="small muted" style="margin:0">Sur Airbnb : Calendrier › Disponibilités › Synchroniser les calendriers › Exporter le calendrier. Chaque départ de voyageurs crée alors un ménage à l'heure de départ, sans action de votre part.</p>
      <button class="btn blue">${h.id ? 'Enregistrer' : 'Ajouter le logement'}</button>
    </form>`;
  }

  views['logements'] = async () => {
    if (!me || me.role !== 'client') return go('#/connexion');
    const [homes, mw] = await Promise.all([api('GET', '/api/homes'), api('GET', '/api/my-workers')]);
    $app.innerHTML = `
      <div class="row"><h1>Mes logements</h1><button class="btn primary" id="addHome">Ajouter un logement</button></div>
      <p class="muted">Enregistrez vos logements une fois : adresse, consignes, checklist, intervenante préférée et calendrier Airbnb.</p>
      <div id="newHome"></div>
      ${homes.length ? '' : '<p class="card muted">Aucun logement enregistré.</p>'}
      ${homes.map((h) => `
        <article class="card">
          <div class="row"><h3>${esc(h.name)}</h3><span class="pill">${h.service === 'airbnb' ? 'Airbnb ' + SIZE[h.size] : SERVICE[h.service]}</span></div>
          <p class="muted" style="margin:6px 0 0">${esc(h.address)} · ${esc(h.cp)}${h.preferred_name ? ` · intervenante préférée : <b>${esc(h.preferred_name)}</b>` : ''}</p>
          ${h.ical_url ? `<p class="small" style="margin:6px 0 0">Calendrier relié${h.last_sync ? ` · dernière synchronisation : ${esc(h.last_sync_result || '')}` : ' · pas encore synchronisé'}</p>` : ''}
          ${h.upcoming.length ? `<p class="small muted" style="margin:6px 0 0">Prochains ménages : ${h.upcoming.map((u) => `${dateFr(u.date)} ${esc(u.time)}`).join(' · ')}</p>` : ''}
          <div class="row" style="justify-content:flex-start;margin-top:10px">
            <button class="btn primary" data-book="${h.id}">Réserver un ménage</button>
            ${h.ical_url ? `<button class="btn ghost" data-sync="${h.id}">Synchroniser le calendrier</button>` : ''}
            <button class="btn ghost" data-edithome="${h.id}">Modifier</button>
            <button class="btn ghost" data-delhome="${h.id}">Supprimer</button>
          </div>
          <div id="home-${h.id}"></div>
        </article>`).join('')}
      ${mw.list.length ? `<section class="card"><h2>Intervenante préférée</h2><p class="small muted">Choisie en priorité pour tous vos ménages quand elle est libre. Sinon, une remplaçante vérifiée intervient et vous êtes prévenu.</p>
        <select id="fav"><option value="">Pas de préférence</option>${mw.list.map((w) => `<option value="${w.id}" ${mw.favorite === w.id ? 'selected' : ''}>${esc(w.name)} · ${w.n} ménage${w.n > 1 ? 's' : ''}${w.note ? ` · ${w.note}/5` : ''}</option>`).join('')}</select></section>` : ''}`;
    const submit = (form) => form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = formData(form);
      const body = { ...fd, photo_consent: !!fd.photo_consent, checklist: (fd.checklist || '').split('\n').map((t) => t.trim()).filter(Boolean) };
      try {
        const id = form.dataset.home;
        const r = await api('POST', id ? `/api/homes/${id}` : '/api/homes', body);
        toast(r.message || 'Logement ajouté.');
        route();
      } catch (err) { toast(err.message); }
    };
    document.getElementById('addHome').onclick = () => {
      const box = document.getElementById('newHome');
      box.innerHTML = box.innerHTML ? '' : `<section class="card">${homeForm()}</section>`;
      const f = box.querySelector('form');
      if (f) submit(f);
    };
    $app.querySelectorAll('[data-edithome]').forEach((b) => b.onclick = () => {
      const box = document.getElementById(`home-${b.dataset.edithome}`);
      if (box.innerHTML) { box.innerHTML = ''; return; }
      box.innerHTML = homeForm(homes.find((h) => String(h.id) === b.dataset.edithome), mw.list);
      submit(box.querySelector('form'));
    });
    $app.querySelectorAll('[data-sync]').forEach((b) => b.onclick = async () => {
      b.disabled = true;
      try { const r = await api('POST', `/api/homes/${b.dataset.sync}/sync`, {}); toast(r.message); route(); } catch (e) { toast(e.message); b.disabled = false; }
    });
    $app.querySelectorAll('[data-delhome]').forEach((b) => b.onclick = async () => {
      try { const r = await api('POST', `/api/homes/${b.dataset.delhome}/delete`, {}); toast(r.message); route(); } catch (e) { toast(e.message); }
    });
    $app.querySelectorAll('[data-book]').forEach((b) => b.onclick = () => { sessionStorage.setItem('home', b.dataset.book); go('#/reserver'); });
    const fav = document.getElementById('fav');
    if (fav) fav.onchange = async () => { try { const r = await api('POST', '/api/favorite', { worker_id: fav.value ? Number(fav.value) : null }); toast(r.message); } catch (e) { toast(e.message); } };
  };

  // ---------- espace intervenante ----------
  // ---- planning de la semaine de l'intervenante ----
  let weekStart = null;
  // niveau de l'intervenante : Bleu, Or, Platine, et ce qu'il reste pour monter
  function levelCard(g) {
    const t = g.tier;
    if (!t) return '';
    const perks = { bleu: 'Bienvenue chez Proprigo !', or: 'Vous êtes prioritaire sur les missions proches.', platine: `Prioritaire sur les missions et +${eur(t.bonus)} de l'heure.` };
    const bar = (have, need) => `<span class="lv-bar"><i style="width:${Math.min(100, Math.round((have / need) * 100))}%"></i></span>`;
    const n = t.next;
    const ratingOk = t.rated >= n?.minRatings && t.rating >= n?.rating;
    return `<div class="level ${t.key}">
        <div class="lv-head"><span class="lv-badge" aria-hidden="true">${t.icon}</span><div><small>Mon niveau</small><b>${esc(t.label)}</b><p>${perks[t.key]}</p></div></div>
        ${n ? `<div class="lv-next"><p><b>Pour passer ${n.icon} ${esc(n.label)}</b>${n.key === 'or' ? ' : priorité sur les missions' : n.bonus ? ` : +${eur(n.bonus)} de l'heure` : ''}</p>
          <div class="lv-row"><span>🧽 Ménages terminés</span><span>${t.missions} / ${n.missions}</span></div>${bar(t.missions, n.missions)}
          <div class="lv-row"><span>⭐ Note moyenne</span><span>${t.rating ? String(t.rating).replace('.', ',') : '–'} / ${String(n.rating).replace('.', ',')}${ratingOk ? ' ✓' : ''}</span></div>${bar(t.rating || 0, n.rating)}
          ${n.key === 'platine' ? `<div class="lv-row"><span>📅 Aucune absence non prévenue (6 mois)</span><span>${t.absences ? `${t.absences} ✗` : '✓'}</span></div>` : ''}
          ${t.rated < n.minRatings ? `<p class="small muted" style="margin:6px 0 0">La note compte à partir de ${n.minRatings} avis (vous en avez ${t.rated}).</p>` : ''}</div>`
        : '<p class="small" style="margin:10px 0 0">Vous avez atteint le plus haut niveau. Merci pour votre travail !</p>'}
      </div>`;
  }
  async function paintWeek(start) {
    const box = document.getElementById('week');
    if (!box) return;
    let w;
    try { w = await api('GET', `/api/worker/week${start ? `?start=${start}` : weekStart ? `?start=${weekStart}` : ''}`); } catch (e) { box.innerHTML = `<h2>Ma semaine</h2><p class="err">${esc(e.message)}</p>`; return; }
    weekStart = w.start;
    const H0 = 7; const H1 = 21; const PX = 34; // une heure = 34 px
    const top = (t) => (Number(t.slice(0, 2)) + Number(t.slice(3, 5)) / 60 - H0) * PX;
    const dayName = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString(LOC(), { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
    const range = `${new Date(w.days[0].date + 'T12:00:00Z').toLocaleDateString(LOC(), { day: 'numeric', month: 'long', timeZone: 'UTC' })} – ${new Date(w.days[6].date + 'T12:00:00Z').toLocaleDateString(LOC(), { day: 'numeric', month: 'long', timeZone: 'UTC' })}`;
    box.innerHTML = `<div class="row"><h2>Ma semaine</h2><span class="row" style="gap:6px"><button class="btn ghost small-btn" data-wk="${w.prev}" aria-label="Semaine précédente">‹</button><button class="btn ghost small-btn" data-wk="" aria-label="Cette semaine">Aujourd'hui</button><button class="btn ghost small-btn" data-wk="${w.next}" aria-label="Semaine suivante">›</button></span></div>
      <p class="small muted" style="margin:4px 0 10px">${range} · ${String(w.hours).replace('.', ',')} h de missions${w.days.some((d) => d.items.some((x) => x.kind === 'offre')) ? ' · <span class="wk-legend offre">proposition à accepter</span>' : ''}</p>
      <div class="wk-scroll"><div class="wk" style="--h:${(H1 - H0) * PX}px">
        <div class="wk-hours">${Array.from({ length: H1 - H0 + 1 }, (_, i) => `<span style="top:${i * PX}px">${H0 + i} h</span>`).join('')}</div>
        ${w.days.map((d) => `<div class="wk-day${d.today ? ' today' : ''}${d.off ? ' off' : ''}"><b class="wk-head">${dayName(d.date)}</b>
          <div class="wk-col">${d.off ? '<span class="wk-off">Congé</span>' : d.avail ? `<i class="wk-avail" style="top:${top(d.avail.start)}px;height:${top(d.avail.end) - top(d.avail.start)}px" title="Disponible ${esc(d.avail.start)} – ${esc(d.avail.end)}"></i>` : '<span class="wk-off">Indisponible</span>'}
          ${d.items.map((x) => `<a class="wk-item ${x.kind} ${x.status || ''}" href="#/intervenante" style="top:${Math.max(0, top(x.time))}px;height:${Math.max(28, x.hours * PX - 3)}px" title="${esc(x.service)} · ${esc(x.time)} · ${esc(x.cp)}"><b>${esc(x.time)}</b> ${esc(x.cp)}<small>${x.kind === 'offre' ? 'À accepter' : x.status === 'terminee' ? 'Terminée' : esc(x.service)}</small></a>`).join('')}</div></div>`).join('')}
      </div></div>
      <p class="small muted wk-note" style="margin:8px 0 0">Zone claire : vos disponibilités. Les missions et propositions apparaissent dans la journée.</p>
      <ul class="wk-list">${w.days.map((d) => `<li class="${d.today ? 'today' : ''}"><div class="wk-l-head"><b>${dayName(d.date)}</b><span class="small muted">${d.off ? 'Congé' : d.avail ? `Dispo ${esc(d.avail.start)}–${esc(d.avail.end)}` : 'Indisponible'}</span></div>
        ${d.items.length ? d.items.map((x) => `<a class="wk-l-item ${x.kind}" href="#/intervenante"><b>${esc(x.time)}</b><span>${esc(x.service)} · ${esc(x.cp)} · ${String(x.hours).replace('.', ',')} h</span>${x.kind === 'offre' ? '<em>à accepter</em>' : ''}</a>`).join('') : ''}</li>`).join('')}</ul>`;
    box.querySelectorAll('[data-wk]').forEach((b) => b.onclick = () => { weekStart = b.dataset.wk || null; paintWeek(b.dataset.wk || undefined); });
  }
  // ---- appli Android / iPhone (Capacitor) : notifications natives ----
  const NATIVE = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() ? window.Capacitor : null;
  // le module natif peut être exposé de deux façons selon la version de Capacitor
  const NPush = NATIVE ? ((NATIVE.Plugins && NATIVE.Plugins.PushNotifications) || (typeof NATIVE.registerPlugin === 'function' ? NATIVE.registerPlugin('PushNotifications') : null)) : null;
  let nativeToken = null;
  if (NPush) {
    NPush.addListener('registration', async (t) => {
      nativeToken = t.value;
      if (me) { try { await api('POST', '/api/push/native', { platform: NATIVE.getPlatform(), token: t.value }); } catch { /* réessayé au prochain lancement */ } }
    });
    NPush.addListener('pushNotificationActionPerformed', (a) => {
      const url = String(a?.notification?.data?.url || '');
      if (url.startsWith('/#/')) location.hash = url.slice(1);
    });
    if (NATIVE.getPlatform() === 'android' && NPush.createChannel) NPush.createChannel({ id: 'proprigo', name: 'Ménages', importance: 4 }).catch(() => {});
  }
  async function nativeRefresh() { // relance l'enregistrement si l'autorisation est déjà donnée
    if (!NPush || !me) return;
    try { if ((await NPush.checkPermissions()).receive === 'granted') await NPush.register(); } catch { /* sans effet */ }
  }
  async function nativeForget() { // à la déconnexion, ce téléphone ne reçoit plus les notifications du compte
    if (!nativeToken) return;
    try { await api('POST', '/api/push/native/remove', { token: nativeToken }); } catch { /* sans effet */ }
    loadMe.nativeDone = false;
  }
  // une fois activées : une phrase simple ; le test reste réservé aux intervenantes et à l'équipe, en lien discret
  const pushOnHtml = (extra = '') => `<p class="push-ok">✓ C'est activé : vous serez prévenu sur ${NATIVE ? 'ce téléphone' : 'cet appareil'}.</p>
      ${me && me.role !== 'client' ? '<button type="button" class="linkish small" id="pushTest">Vérifier que ça marche</button>' : ''}${extra}`;
  async function paintNativePush(box, intro) {
    const head = '<h2>Notifications</h2>';
    let perm = 'prompt';
    try { perm = (await NPush.checkPermissions()).receive; } catch { /* inconnu */ }
    box.innerHTML = `${head}<p class="small muted">${intro}</p>
      ${perm === 'denied' ? '<p class="msg warn">Les notifications sont bloquées. Autorisez-les dans les Réglages du téléphone, rubrique Proprigo.</p>'
        : perm === 'granted' ? pushOnHtml()
          : '<button class="btn blue" id="pushOn">Activer les notifications</button>'}`;
    const onBtn = document.getElementById('pushOn');
    if (onBtn) onBtn.onclick = async () => {
      onBtn.disabled = true;
      try {
        if ((await NPush.requestPermissions()).receive !== 'granted') throw new Error('Notifications refusées. Vous pourrez les autoriser dans les Réglages du téléphone.');
        await NPush.register();
        toast('Notifications activées sur ce téléphone.'); setTimeout(() => paintNativePush(box, intro), 800);
      } catch (e) { toast(e.message || 'Activation impossible.'); onBtn.disabled = false; }
    };
    const t = document.getElementById('pushTest');
    if (t) t.onclick = async () => { try { const r = await api('POST', '/api/push/test', {}); toast(r.message); } catch (e) { toast(e.message); } };
  }
  // ---- notifications sur ce téléphone (intervenante et client) ----
  async function paintPush(box, intro) {
    if (!box) return;
    if (NPush) return paintNativePush(box, intro);
    if (NATIVE) { box.innerHTML = '<h2>Notifications</h2><p class="small muted">Les notifications ne sont pas disponibles dans cette version de l\'application. Mettez-la à jour depuis le store.</p>'; return; }
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const head = '<h2>Notifications</h2>';
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      box.innerHTML = `${head}<p class="small muted">${ios && !standalone ? 'Sur iPhone : touchez Partager puis « Sur l\'écran d\'accueil », ouvrez Proprigo depuis la nouvelle icône, et revenez ici pour activer les notifications.' : 'Ce navigateur ne gère pas les notifications. Essayez avec Chrome ou Firefox, ou installez Proprigo sur l\'écran d\'accueil.'}</p>`;
      return;
    }
    let key; let reg; let sub;
    try { key = await api('GET', '/api/push/key'); reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('sw')), 8000))]); sub = await reg.pushManager.getSubscription(); } catch { box.innerHTML = `${head}<p class="small muted">Notifications indisponibles pour le moment.</p>`; return; }
    const on = Boolean(sub) && Notification.permission === 'granted';
    box.innerHTML = `${head}<p class="small muted">${intro}</p>
      ${Notification.permission === 'denied' ? '<p class="msg warn">Les notifications sont bloquées pour Proprigo. Autorisez-les dans les réglages du navigateur (icône du cadenas à côté de l\'adresse), puis revenez ici.</p>'
        : on ? pushOnHtml(' <button type="button" class="linkish small" id="pushOff">Ne plus être prévenu</button>')
          : '<button class="btn blue" id="pushOn">Activer les notifications</button>'}`;
    const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
    const onBtn = document.getElementById('pushOn');
    if (onBtn) onBtn.onclick = async () => {
      onBtn.disabled = true;
      try {
        if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications refusées. Vous pourrez les autoriser plus tard dans les réglages.');
        const s2 = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key.publicKey) });
        const r = await api('POST', '/api/push/subscribe', s2.toJSON());
        toast(r.message); paintPush(box, intro);
      } catch (e) { toast(e.message || 'Activation impossible.'); onBtn.disabled = false; }
    };
    const t = document.getElementById('pushTest');
    if (t) t.onclick = async () => { try { const r = await api('POST', '/api/push/test', {}); toast(r.message); } catch (e) { toast(e.message); } };
    const off = document.getElementById('pushOff');
    if (off) off.onclick = async () => { try { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); toast('Notifications désactivées sur cet appareil.'); paintPush(box, intro); } catch (e) { toast(e.message); } };
  }
  // Pièces justificatives de l'intervenante : dépôt et suivi de la vérification.
  const DOC_STATUS = { a_verifier: ['En cours de vérification', ''], valide: ['Validé', 'ok'], refuse: ['À renvoyer', 'warn'] };
  async function paintDocs() {
    const box = document.getElementById('docs');
    if (!box) return;
    let d;
    try { d = await api('GET', '/api/worker/documents'); } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    box.innerHTML = `${box.closest('details') ? '' : '<h2>Mes documents</h2>'}
      ${d.expired && d.expired.length ? `<p class="msg warn">⚠️ Document expiré : ${d.expired.map(esc).join(' ; ')}. Vous ne recevez plus de nouvelles missions tant que la nouvelle version n'est pas validée.</p>` : ''}
      <p class="small muted">${d.complete ? 'Toutes les pièces obligatoires sont validées. Merci !' : 'Déposez chaque pièce en PDF ou en photo bien nette (5 Mo maximum). Seule l\'équipe Proprigo les voit.'}</p>
      <ul class="plain doc-list">${d.list.map((k) => {
        const st = k.latest ? DOC_STATUS[k.latest.status] : null;
        return `<li><span><b>${esc(k.label)}</b>${k.required ? '' : ' <span class="muted small">(facultatif)</span>'}<br>
          ${st ? `<span class="pill ${st[1]}">${st[0]}</span>${k.latest.status === 'refuse' && k.latest.note ? ` <span class="small">${esc(k.latest.note)}</span>` : ''} <a class="small" href="/api/documents/${k.latest.id}" target="_blank" rel="noopener">Voir</a>` : '<span class="small muted">Pas encore déposé</span>'}
          ${k.valid_until ? `<br><span class="small ${k.expired ? 'err' : k.soon ? 'warn-text' : 'muted'}">${k.expired ? `⚠️ Expiré depuis le ${dayFr(k.valid_until)}` : `Valable jusqu'au ${dayFr(k.valid_until)}${k.soon ? ` : plus que ${k.days_left} jour${k.days_left > 1 ? 's' : ''}` : ''}`}</span>` : ''}</span>
          ${k.latest && k.latest.status === 'valide' && !k.soon && !k.expired ? '' : `<span class="doc-up">${k.expiring && !(k.latest && k.latest.status === 'a_verifier') ? `<label class="small">Valable jusqu'au<input type="date" data-exp="${k.kind}"></label>` : ''}<label class="btn ghost small-btn">${k.latest && k.latest.status === 'valide' ? 'Envoyer la nouvelle version' : k.latest ? 'Remplacer' : 'Déposer'}<input type="file" accept="application/pdf,image/jpeg,image/png" data-doc="${k.kind}" hidden></label></span>`}</li>`;
      }).join('')}</ul>`;
    box.querySelectorAll('[data-doc]').forEach((inp) => inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        let data;
        if (f.type === 'application/pdf') {
          if (f.size > 5_000_000) throw new Error('PDF trop lourd (5 Mo maximum).');
          data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('Fichier illisible.')); fr.readAsDataURL(f); });
        } else data = await shrink(f);
        toast('Envoi en cours…');
        const exp = box.querySelector(`[data-exp="${inp.dataset.doc}"]`);
        const r = await api('POST', '/api/worker/documents', { kind: inp.dataset.doc, data, expires_on: exp && exp.value ? exp.value : undefined });
        toast(r.message);
        paintDocs();
      } catch (e) { toast(e.message); }
    });
  }
  views['intervenante'] = async () => {
    if (!me || me.role !== 'intervenante') return go('#/connexion');
    const r = await api('GET', '/api/worker/missions');
    const p = r.profile;
    const isI = p.statut === 'I';
    const nToday = r.missions.filter((b) => b.date <= todayParis()).length;
    const head = `<section class="hello">
        <div class="hello-text">
          <p class="hello-hi">Bonjour ${esc(p.name.split(' ')[0])}</p>
          <h1>${!r.active ? 'Votre candidature' : nToday ? `${nToday} mission${nToday > 1 ? 's' : ''} aujourd'hui` : 'Pas de mission aujourd\'hui'}</h1>
          <p class="hello-sub">${isI ? 'Indépendante' : 'Salariée'} · secteur ${esc(p.cp)}</p>
          ${langPicker()}
        </div>
        <div class="hello-art" aria-hidden="true">${nToday ? ART.services.grand : ART.empty}</div>
      </section>`;
    const cal = {};
    for (const a of r.availability) cal[a.weekday] = a;
    const calendar = `
      <details class="card stack avail-box"><summary><h2>Mes disponibilités</h2><span class="small muted">${Object.keys(cal).length ? `${Object.keys(cal).length} jour${Object.keys(cal).length > 1 ? 's' : ''} par semaine · modifier` : 'À remplir'}</span></summary>
        <p class="small muted">Vous ne recevez des missions que pendant ces horaires.</p>
        <form id="cal" class="stack"><div class="avail">${[1, 2, 3, 4, 5, 6, 0].map((d) => `
          <div class="day ${cal[d] ? '' : 'off'}" data-day="${d}">
            <div class="day-head"><span id="dl${d}">${WEEKDAYS[d]}</span><span class="row" style="gap:10px;flex-wrap:nowrap"><span class="small muted" data-state="${d}">${cal[d] ? 'Disponible' : 'Repos'}</span><span class="switch"><input type="checkbox" role="switch" name="on${d}" aria-labelledby="dl${d}" ${cal[d] ? 'checked' : ''}><span></span></span></span></div>
            <div class="hours" ${cal[d] ? '' : 'hidden'}>
              <select name="s${d}" aria-label="${WEEKDAYS[d]}, de">${HALF_HOURS.map((t) => `<option value="${t}" ${(cal[d] ? cal[d].start : '08:00') === t ? 'selected' : ''}>De ${t}</option>`).join('')}</select>
              <span class="muted">→</span>
              <select name="e${d}" aria-label="${WEEKDAYS[d]}, jusqu'à">${HALF_HOURS.map((t) => `<option value="${t}" ${(cal[d] ? cal[d].end : '18:00') === t ? 'selected' : ''}>À ${t}</option>`).join('')}</select>
            </div>
          </div>`).join('')}</div>
          <button class="btn blue full">Enregistrer mes disponibilités</button></form>
      </details>
      <section class="card stack"><h2>Mes congés</h2>
        ${r.timeoff.length ? `<ul>${r.timeoff.map((t) => `<li>Du ${dateFr(t.start_date)} au ${dateFr(t.end_date)} <button class="btn ghost" data-deloff="${t.id}">Supprimer</button></li>`).join('')}</ul>` : '<p class="small muted">Aucun congé prévu.</p>'}
        <form id="off" class="grid2" style="gap:12px;align-items:end"><label>Du<input type="date" name="start_date" min="${todayParis()}" required></label><label>Au<input type="date" name="end_date" min="${todayParis()}" required></label><button class="btn blue">Ajouter le congé</button></form>
      </section>`;
    if (!r.active) {
      $app.innerHTML = `${head}
        <section class="card">
          <h2>Votre candidature</h2>
          <p class="muted">Vous recevrez des missions une fois toutes les étapes validées par notre équipe.</p>
          <div class="prog"><i style="width:${(p.step / (r.steps.length - 1)) * 100}%"></i></div>
          <ol>${r.steps.map((s, i) => `<li>${i < p.step ? '✓ ' : ''}${i === p.step ? '<b>' : ''}${esc(s)}${i === p.step ? ' (en cours)</b>' : ''}</li>`).join('')}</ol>
        </section>
        ${p.rejected_at ? '<p class="card msg warn">Votre candidature est close. Vos documents seront supprimés dans 30 jours.</p>' : '<section class="card stack" id="docs"><h2>Mes documents</h2><p class="muted small">Chargement…</p></section>'}
        ${p.rejected_at ? '' : '<p class="small muted">Vos disponibilités et vos congés se règlent ici dès que votre candidature est acceptée.</p>'}`;
      paintDocs();
      return;
    }
    const tday = todayParis();
    const today = r.missions.filter((b) => b.date <= tday);
    const later = r.missions.filter((b) => b.date > tday);
    const card = (b) => `
        <article class="card">
          <div class="row"><h3>${esc(label(b))}</h3>${pill(b.status)}</div>
          <p style="margin:6px 0 0">${dateFr(b.date)} à ${esc(b.time)} · <b>${esc(b.address)}</b>, ${esc(b.cp)}</p>
          <p class="muted" style="margin:4px 0 0">Client : ${esc(b.client_name.split(' ')[0])}${b.home_name ? ` · ${esc(b.home_name)}` : ''}</p>
          ${['attribuee', 'en_cours'].includes(b.status) ? routeLinks(b) : ''}
          ${b.team_notes && b.team_notes.length ? `<div class="box team-note"><b>📝 À savoir (équipe Proprigo)</b>${b.team_notes.map((n) => `<p class="instructions" style="margin:4px 0 0;white-space:pre-line">${esc(n.text)}</p>`).join('')}</div>` : ''}
          ${b.instructions ? `<div class="box"><b>Consignes du logement</b><p class="instructions" style="margin:4px 0 0;white-space:pre-line">${esc(b.instructions)}</p></div>` : ''}
          ${b.kit ? '<p><span class="pill warn">Apporter le kit matériel et produits</span></p>' : ''}
          ${b.checklist.length ? `${shine(b)}<fieldset class="box"><legend>À faire</legend>${b.checklist.map((t, i) => `<label class="check"><input type="checkbox" data-check="${b.id}" data-index="${i}" ${t.done ? 'checked' : ''}> ${esc(t.task)}</label>`).join('')}</fieldset>` : ''}
          ${b.photo_consent ? `<div class="box stack"><b>Photos avant / après</b>
            ${b.photos.length ? `<div class="photos">${b.photos.map((ph) => `<figure><img src="/api/photos/${ph.id}" alt="Photo ${ph.kind}" loading="lazy"><figcaption>${ph.kind === 'avant' ? 'Avant' : 'Après'}</figcaption></figure>`).join('')}</div>` : ''}
            ${b.status === 'en_cours' ? `<div class="row" style="justify-content:flex-start"><label class="btn ghost">📷 Photo avant<input type="file" accept="image/*" capture="environment" data-photo="${b.id}" data-kind="avant" hidden></label>
              <label class="btn ghost">📷 Photo après<input type="file" accept="image/*" capture="environment" data-photo="${b.id}" data-kind="apres" hidden></label></div>
              <p class="small muted">Au moins une photo « après » est demandée pour terminer.</p>` : '<p class="small muted">Le client a accepté les photos : vous pourrez les prendre une fois le ménage commencé.</p>'}
          </div>` : '<p class="small muted">Pas de photos pour ce ménage (le client ne l\'a pas demandé).</p>'}
          ${act(b)}
          <div class="bk-main"><button class="btn ghost" data-thread="${b.id}">💬 Messages${b.messages ? ` (${b.messages})` : ''}</button>${['attribuee', 'en_cours'].includes(b.status) && b.date === todayParis() ? `<button class="btn ghost warn-ghost" data-problem="${b.id}">⚠️ Problème</button>` : ''}</div>
          <div id="problem-${b.id}"></div>
          <div id="thread-${b.id}"></div>
        </article>`;
    // le jour J : je pars → je suis arrivée → commencer → terminer
    // le jour J, une seule grande action à la fois : je pars → je suis arrivée → commencer → terminer
    const act = (b) => {
      if (b.status === 'en_cours') return `<div class="next-step"><button class="btn primary full" data-act="finish" data-id="${b.id}">✅ Terminer le ménage</button></div>`;
      if (b.status !== 'attribuee') return '';
      if (b.date !== todayParis()) return '<p class="small muted next-hint">Les boutons « Je pars », « Je suis arrivée » et « Commencer » apparaîtront le jour de la mission.</p>';
      if (!b.on_way_at && !b.arrived_at) return `<div class="next-step"><button class="btn blue full" data-act="onway" data-id="${b.id}">🚶 Je pars</button>
        <p class="small muted next-hint">Le client est prévenu de votre arrivée. Déjà sur place ? <button type="button" class="linkish" data-act="start" data-id="${b.id}">Commencer le ménage</button></p></div>`;
      if (!b.arrived_at) return `<div class="next-step"><p class="step-done">✓ En route${b.eta_at ? `, arrivée prévue vers ${hhmm(b.eta_at)}` : ''} · <button type="button" class="linkish" data-act="onway" data-id="${b.id}">changer l'heure</button></p>
        <button class="btn blue full" data-act="arrived" data-id="${b.id}">📍 Je suis arrivée</button>
        <p class="small muted next-hint"><button type="button" class="linkish" data-act="start" data-id="${b.id}">Commencer directement le ménage</button></p></div>`;
      return `<div class="next-step"><p class="step-done">✓ Arrivée chez le client</p><button class="btn primary full" data-act="start" data-id="${b.id}">▶ Commencer le ménage</button></div>`;
    };
    // itinéraire de la journée : toutes les adresses du jour dans l'ordre, depuis l'endroit où elle se trouve
    const dayRoute = (list) => {
      const stops = list.filter((b) => ['attribuee', 'en_cours'].includes(b.status) && b.date === tday).sort((x, y) => x.time.localeCompare(y.time));
      if (stops.length < 2) return '';
      const url = `https://www.google.com/maps/dir//${stops.map((b) => encodeURIComponent(`${b.address}, ${b.cp}, France`)).join('/')}`;
      return `<a class="btn ghost day-route" href="${url}" target="_blank" rel="noopener">🗺️ Itinéraire de la journée <span class="small muted">(${stops.length} adresses, dans l'ordre)</span></a>`;
    };
    const routeLinks = (b) => { const dest = encodeURIComponent(`${b.address}, ${b.cp}, France`); return `<div class="route-links"><a href="https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=transit" target="_blank" rel="noopener">Itinéraire Google Maps</a><a href="https://citymapper.com/directions?endaddress=${dest}" target="_blank" rel="noopener">Citymapper</a></div>`; };
    $app.innerHTML = `${head}
      ${p.absent ? '<p class="card"><span class="pill warn">Absente</span> Vos missions sont confiées à d\'autres intervenantes.</p>' : ''}
      <p class="muted">${isI ? `Vous choisissez vos missions et pouvez refuser sans pénalité. Votre tarif : ${eur(p.rate)}/h.` : 'Vos missions sont attribuées par le planning Proprigo.'}</p>
      ${isI ? `<h2 style="margin-top:20px">Propositions</h2>${r.offers.length ? r.offers.map((b) => `
        <article class="card">
          <div class="row"><h3>${esc(label(b))}</h3><span class="pill">${eur(b.earn)}</span></div>
          <p class="muted" style="margin:6px 0 0">${dateFr(b.date)} à ${esc(b.time)} · ${esc(b.cp)} · ${String(b.hours).replace('.', ',')} h${b.kit ? ' · apporter le kit matériel' : ''}</p>
          <p class="small muted">L'adresse exacte s'affiche après acceptation.</p>
          <div class="row" style="justify-content:flex-start"><button class="btn ghost" data-act="refuse" data-id="${b.id}">✖️ Refuser</button><button class="btn primary" data-act="accept" data-id="${b.id}">✅ Accepter</button></div>
        </article>`).join('') : '<p class="card muted">Aucune proposition pour le moment.</p>'}` : ''}
      ${today.length ? `<h2 style="margin-top:20px">Aujourd'hui</h2>${dayRoute(today)}${today.map(card).join('')}` : '<p class="card muted" style="margin-top:20px">Pas de mission aujourd\'hui.</p>'}
      ${later.length ? `<h2 style="margin-top:20px">À venir</h2>${(() => { const one = (b) => `<details class="card later"><summary><b>${dateFr(b.date)} ${esc(b.time)}</b> · ${esc(label(b))} · ${esc(b.cp)} ${pill(b.status)}</summary>${card(b)}</details>`; return later.slice(0, 5).map(one).join('') + (later.length > 5 ? `<details class="more"><summary>Voir les ${later.length - 5} autres missions</summary>${later.slice(5).map(one).join('')}</details>` : ''); })()}` : ''}
      <section class="card" id="week"><h2>Ma semaine</h2><p class="muted small">Chargement…</p></section>
      <section class="card" id="pushBox"></section>
      <section class="card" id="gains"><h2>Mes gains</h2><p class="muted small">Chargement…</p></section>
      ${calendar}
      <details class="card" id="docsBox"><summary><b>Mes documents</b></summary><div class="stack" id="docs"></div></details>`;
    const db0 = document.getElementById('docsBox');
    if (db0) db0.addEventListener('toggle', () => { if (db0.open) paintDocs(); }, { once: true });
    paintWeek();
    paintPush(document.getElementById('pushBox'), 'Recevez les nouvelles missions sur ce téléphone, même application fermée.');
    $app.querySelectorAll('[data-act]').forEach((btn) => btn.onclick = async () => {
      // « Je pars » : l'intervenante indique dans combien de temps elle arrive ; le client voit l'heure estimée.
      if (btn.dataset.act === 'onway') {
        const host = btn.closest('article, .card') || btn.parentElement;
        let box = host.querySelector('.eta-pick');
        if (box) { box.remove(); return; }
        box = document.createElement('div');
        box.className = 'eta-pick';
        box.innerHTML = `<p class="small" style="margin:8px 0 6px"><b>J'arrive dans…</b></p><div class="chips">${[10, 15, 20, 30, 45, 60].map((m) => `<button type="button" data-eta="${m}">${m} min</button>`).join('')}</div>`;
        (btn.closest('.next-step') || btn.parentElement).after(box);
        box.querySelectorAll('[data-eta]').forEach((c) => c.onclick = async () => {
          try { const r = await api('POST', `/api/worker/missions/${btn.dataset.id}/onway`, { eta: Number(c.dataset.eta) }); toast(r.message); route(); } catch (e) { toast(e.message); }
        });
        return;
      }
      try { const r = await api('POST', `/api/worker/missions/${btn.dataset.id}/${btn.dataset.act}`, {}); toast(r.message || 'C\'est enregistré.'); route(); } catch (e) { toast(e.message); }
    });
    // problème sur place : alerte immédiate de l'équipe
    $app.querySelectorAll('[data-problem]').forEach((btn) => btn.onclick = () => {
      const host = document.getElementById(`problem-${btn.dataset.problem}`);
      if (host.innerHTML) { host.innerHTML = ''; return; }
      host.innerHTML = `<form class="box stack problem-form">
        <b>Que se passe-t-il ?</b>
        ${[['acces', "Je n'arrive pas à entrer"], ['casse', 'Un objet est cassé ou abîmé'], ['etat', 'Logement bien plus sale que prévu'], ['securite', 'Je ne me sens pas en sécurité'], ['autre', 'Autre problème']].map(([k, t]) => `<label class="check"><input type="radio" name="kind" value="${k}" required> ${t}</label>`).join('')}
        <label>Précisions (facultatif)<textarea name="text" rows="2" maxlength="600"></textarea></label>
        <p class="small muted" style="margin:0">En cas de danger, appelez le 17.</p>
        <button class="btn primary full">Prévenir l'équipe maintenant</button></form>`;
      host.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        try { const r = await api('POST', `/api/worker/missions/${btn.dataset.problem}/problem`, formData(e.target)); host.innerHTML = `<p class="msg ok">${esc(r.message)}</p>`; } catch (err) { toast(err.message); }
      };
    });
    // mes gains
    api('GET', '/api/worker/earnings').then((g) => {
      const el = document.getElementById('gains');
      if (!el) return;
      const val = (x) => (g.statut === 'I' ? eur(x.eur) : `${String(x.h).replace('.', ',')} h`);
      const mname = (m) => new Date(m + '-15T12:00:00Z').toLocaleDateString(LOC(), { month: 'long', timeZone: 'UTC' });
      const max = Math.max(1, ...g.history.map((h) => h.h));
      el.innerHTML = `${levelCard(g)}<h2>Mes gains</h2>${g.tipsMonth ? `<p class="tip-done" style="margin:0 0 10px">💝 ${eur(g.tipsMonth)} de pourboires ce mois-ci</p>` : ''}
        <div class="gain-grid">
          <div class="gain main"><span>Ce mois-ci</span><b>${val(g.month)}</b><small>${g.month.n} ménage${g.month.n > 1 ? 's' : ''} terminé${g.month.n > 1 ? 's' : ''}</small></div>
          <div class="gain"><span>Mois dernier</span><b>${val(g.lastMonth)}</b><small>${g.lastMonth.n} ménage${g.lastMonth.n > 1 ? 's' : ''}</small></div>
          <div class="gain"><span>À venir</span><b>${val(g.upcoming)}</b><small>${g.upcoming.n} mission${g.upcoming.n > 1 ? 's' : ''} prévue${g.upcoming.n > 1 ? 's' : ''}</small></div>
        </div>
        ${g.history.length ? `<div class="gain-bars" aria-label="Heures des derniers mois">${g.history.slice().reverse().map((h) => `<div><i style="height:${Math.max(6, Math.round((h.h / max) * 70))}px"></i><span>${new Date(h.month + '-15T12:00:00Z').toLocaleDateString(LOC(), { month: 'short', timeZone: 'UTC' })}</span></div>`).join('')}</div>` : ''}
        <p class="small muted" style="margin:8px 0 0">${g.statut === 'I' ? `Calculé avec votre tarif de ${eur(g.rate)}/h, avant vos cotisations.` : 'Heures de ménage réalisées. Le salaire figure sur votre fiche de paie.'}</p>
        ${g.history.length ? `<details class="gain-history"><summary>Historique mois par mois</summary><div class="table-wrap"><table class="stats" style="min-width:0">
          <thead><tr><th>Mois</th><th class="n">Ménages</th><th class="n">Heures</th>${g.statut === 'I' ? '<th class="n">Gagné</th><th class="n">Versé</th>' : ''}<th></th></tr></thead>
          <tbody>${g.history.map((h) => `<tr><td>${new Date(h.month + '-15T12:00:00Z').toLocaleDateString(LOC(), { month: 'long', year: 'numeric', timeZone: 'UTC' })}</td><td class="n">${h.n}</td><td class="n">${String(h.h).replace('.', ',')}</td>${g.statut === 'I' ? `<td class="n">${eur(h.eur)}</td><td class="n">${h.paid === null ? '–' : eur(h.paid)}</td>` : ''}<td><a class="small" href="/api/worker/statement?month=${h.month}" target="_blank" rel="noopener">📄 Relevé</a></td></tr>`).join('')}</tbody></table></div>
          ${g.statut === 'I' ? '<p class="small muted">« Versé » : virements reçus ce mois-là (ils peuvent porter sur des ménages du mois précédent).</p>' : ''}</details>` : ''}
        ${g.statut === 'I' ? `<div class="pay-box">
          <div><span>En attente de versement</span><b>${eur(g.pending)}</b><small>Versé chaque semaine par virement.</small></div>
          <div class="${g.bonus.eligible ? 'on' : ''}"><span>Bonus de niveau</span><b>${g.bonus.eligible ? `+${eur(g.bonus.perHour)} / h` : 'Pas encore'}</b><small>${g.bonus.eligible ? 'Ajouté à chaque versement.' : 'Au niveau Platine.'}</small></div>
        </div>
        ${g.paid.length ? `<ul class="plain small">${g.paid.map((p) => `<li><span>Semaine du ${dateFr(p.week_start)}</span><b>${eur(p.amount)}</b></li>`).join('')}</ul>` : ''}` : ''}`;
    }).catch(() => {});
    $app.querySelectorAll('[data-check]').forEach((c) => c.onchange = async () => {
      updateShine(c.dataset.check);
      try { await api('POST', `/api/worker/missions/${c.dataset.check}/checklist`, { index: Number(c.dataset.index), done: c.checked }); } catch (e) { toast(e.message); c.checked = !c.checked; updateShine(c.dataset.check); }
    });
    $app.querySelectorAll('[data-photo]').forEach((inp) => inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      try {
        toast('Envoi de la photo…');
        await api('POST', `/api/bookings/${inp.dataset.photo}/photos`, { kind: inp.dataset.kind, data: await shrink(f) });
        toast('Photo ajoutée.');
        route();
      } catch (e) { toast(e.message); }
    });
    bindThreads(["J'aurai environ 15 min de retard", 'Je suis arrivée', "Je n'arrive pas à entrer dans le logement", 'Ménage terminé']);
    bindCalendar();
  };

  function bindCalendar() {
    const cal = document.getElementById('cal');
    if (!cal) return;
    cal.querySelectorAll('.day input[type=checkbox]').forEach((c) => c.onchange = () => {
      const day = c.closest('.day');
      day.classList.toggle('off', !c.checked);
      day.querySelector('.hours').hidden = !c.checked;
      day.querySelector('[data-state]').textContent = c.checked ? 'Disponible' : 'Repos';
    });
    cal.onsubmit = async (e) => {
      e.preventDefault();
      const fd = formData(cal);
      const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => fd['on' + d]).map((d) => ({ weekday: d, start: fd['s' + d], end: fd['e' + d] }));
      try { const r = await api('POST', '/api/worker/availability', { days }); toast(r.message); route(); } catch (err) { toast(err.message); }
    };
    document.getElementById('off').onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api('POST', '/api/worker/timeoff', formData(e.target)); toast(r.message); route(); } catch (err) { toast(err.message); }
    };
    $app.querySelectorAll('[data-deloff]').forEach((b) => b.onclick = async () => { await api('POST', `/api/worker/timeoff/${b.dataset.deloff}/delete`, {}); route(); });
  }

  // ---------- espace administrateur ----------
  // types du journal, reconnus à partir du texte
  const EVENT_TYPES = {
    attribution: ['Attributions', /attribuée|proposée|acceptée|refusée|choisie/i],
    reservation: ['Réservations', /enregistrée|modifiée|récurrence/i],
    annulation: ['Annulations et remboursements', /annul|rembours/i],
    calendrier: ['Calendriers', /calendrier/i],
    equipe: ['Équipe', /candidature|absente|présente|étape|intervenante active/i],
    systeme: ['Système', /sauvegarde|e-mail|compte/i],
  };
  const eventType = (t) => (Object.entries(EVENT_TYPES).find(([, [, re]]) => re.test(t)) || ['autre'])[0];

  views['admin'] = async (params) => {
    if (!me || me.role !== 'admin') return go('#/connexion');
    const r = await api('GET', '/api/admin/overview');
    const owner = r.staff !== 'planning';
    const m = r.metrics;
    const k = r.kpis;
    const ob = await api('GET', '/api/admin/outbox').catch(() => ({ list: [] }));
    const bk = await api('GET', '/api/admin/backups').catch(() => ({ enabled: false, list: [] }));
    const in3 = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    const todo = [
      ...r.bookings.filter((b) => ['en_attente', 'proposee'].includes(b.status) && b.paid && b.date <= in3).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
        .map((b) => `<li class="${b.status === 'en_attente' ? 'urgent' : ''}"><span><b>${b.status === 'en_attente' ? (b.paid ? 'Payée — intervenante à attribuer' : 'Paiement en attente') : 'En attente d\'acceptation'}</b> · réservation n° ${b.id}, ${dateFr(b.date)} ${esc(b.time)}, ${esc(b.cp)}</span><button class="btn ghost" data-goto-bk="${b.id}">Choisir l'intervenante</button><div id="todo-pick-${b.id}" style="flex-basis:100%"></div></li>`),
      ...(r.icalFlagged || []).map((x) => `<li class="urgent"><span><b>Séjour disparu du calendrier</b> · ménage n° ${x.id}${x.home_name ? ` (${esc(x.home_name)})` : ''}, ${dateFr(x.date)} ${esc(x.time)}. Vérifiez avec le client.</span><span class="row" style="gap:6px;flex-wrap:wrap"><button class="btn ghost" data-ikeep="${x.id}">Garder</button><button class="btn ghost" data-icancel="${x.id}">Annuler et rembourser</button></span></li>`),
      ...(r.quoteRequests ? [`<li class="urgent"><span><b>Demandes de devis</b> · ${r.quoteRequests} nouvelle${r.quoteRequests > 1 ? 's' : ''}</span><button class="btn ghost" id="openDevis">Voir</button></li>`] : []),
      ...r.incidents.map((x) => `<li class="urgent"><span><b>${x.source === 'garantie' ? 'Garantie : retour gratuit à planifier' : x.source === 'litige' ? 'Contestation bancaire' : x.source === 'intervenante' ? 'Problème sur place' : x.source === 'note' ? 'Note basse' : 'Réclamation'}</b> · réservation n° ${x.booking_id} : ${esc(x.text.slice(0, 80))}${x.text.length > 80 ? '…' : ''}</span><button class="btn ghost" data-goto="incidents">Voir</button></li>`),
      ...r.workers.filter((w) => w.absent).map((w) => `<li><span><b>Absente</b> · ${esc(w.name)}</span><button class="btn ghost" data-absent="${w.user_id}">Marquer présente</button></li>`),
      ...(k.aRembourser.n ? [`<li><span><b>Remboursements</b> · ${k.aRembourser.n} réservation(s), ${eur(k.aRembourser.montant)}</span><button class="btn ghost" data-goto="table">Voir</button></li>`] : []),
      ...(r.workers.some((w) => w.docs && w.docs.toCheck && !w.rejected) ? [`<li class="urgent"><span><b>Documents à vérifier</b> · ${r.workers.filter((w) => w.docs && w.docs.toCheck && !w.rejected).map((w) => esc(w.name)).join(', ')}</span><button class="btn ghost" data-goto="team">Voir</button></li>`] : []),
      ...(r.workers.some((w) => !w.active && !w.rejected) ? [`<li><span><b>Candidatures</b> · ${r.workers.filter((w) => !w.active && !w.rejected).length} intervenante(s) en cours de recrutement</span><button class="btn ghost" data-goto="team">Voir</button></li>`] : []),
    ];
    $app.innerHTML = `
      <section class="hello">
        <div class="hello-text">
          <p class="hello-hi">Tableau de bord</p>
          <h1>${todo.length ? `${todo.length} chose${todo.length > 1 ? 's' : ''} à traiter` : 'Tout est en ordre'}</h1>
          <p class="hello-sub">${k.reservations} réservation${k.reservations > 1 ? 's' : ''} · note moyenne ${k.noteMoyenne ? String(k.noteMoyenne).replace('.', ',') + ' / 5' : '–'}</p>
        </div>
        <div class="hello-art" aria-hidden="true">${todo.length ? ART.empty : ART.done}</div>
      </section>
      ${r.paymentsEnabled ? '' : '<p class="card"><span class="pill warn">Paiement simulé</span> Aucun argent n\'est encaissé dans cette version. Le chiffre d\'affaires affiché est théorique.</p>'}
      <nav class="tabs" role="tablist" aria-label="Administration">${[['todo', `À traiter${todo.length ? ` (${todo.length})` : ''}`], ['planning', 'Planning'], ['resa', 'Réservations'], ['equipe', 'Équipe'], ...(owner ? [['chiffres', 'Chiffres'], ['paiements', 'Paiements'], ['tarifs', 'Tarifs et zones'], ['suivi', 'Suivi']] : [])].map(([k, t]) => `<button type="button" role="tab" data-tab-btn="${k}">${t}</button>`).join('')}</nav>
      <section class="card todo" data-tab="todo"><h2>À traiter maintenant</h2>${todo.length ? `<ul class="plain">${todo.join('')}</ul>` : '<p class="msg ok">Rien d\'urgent : toutes les missions des 3 prochains jours ont une intervenante.</p>'}</section>
      ${m ? `<section class="card" data-tab="chiffres"><h2>Argent réellement encaissé</h2>
        <p class="small muted">Paiements confirmés par Stripe, remboursements déduits.</p>
        <div class="gain-grid">
          <div class="gain main"><span>Ce mois-ci</span><b>${eur(m.encaisseMois)}</b><small>${m.encaisseMoisPrecedent ? `${m.encaisseMois >= m.encaisseMoisPrecedent ? '+' : ''}${Math.round(((m.encaisseMois - m.encaisseMoisPrecedent) / m.encaisseMoisPrecedent) * 100)} % sur le mois dernier` : 'Premier mois'}</small></div>
          <div class="gain"><span>Mois dernier</span><b>${eur(m.encaisseMoisPrecedent)}</b><small>Encaissé net</small></div>
          <div class="gain"><span>Depuis le début</span><b>${eur(m.encaisseTotal)}</b><small>Encaissé net</small></div>
        </div>
        <div class="gain-grid" style="margin-top:10px">
          <div class="gain"><span>Clients qui reviennent</span><b>${m.clientsActifs ? Math.round((m.clientsFideles / m.clientsActifs) * 100) : 0} %</b><small>${m.clientsFideles} sur ${m.clientsActifs} ont fait 2 ménages ou plus</small></div>
          <div class="gain"><span>Annulations</span><b>${m.tauxAnnulation} %</b><small>des réservations</small></div>
          <div class="gain"><span>Parrainages</span><b>${m.parrainages}</b><small>clients venus par un proche</small></div>
        </div>
        ${m.zones.length ? `<h3 style="margin-top:16px">Codes postaux les plus demandés</h3><ul class="plain">${m.zones.map((z) => `<li><span>${esc(z.cp)}</span><span class="muted">${z.n} réservation${z.n > 1 ? 's' : ''}</span></li>`).join('')}</ul>` : ''}
      </section>` : ''}
      ${owner ? '<section class="card" data-tab="chiffres" id="payoutsBox"><h2>À verser aux indépendantes</h2><p class="muted small">Chargement…</p></section>' : ''}
      <div class="kpis" data-tab="chiffres">
        <div class="kpi"><span class="small muted">Réservations</span><b>${k.reservations}</b><span class="small muted">${k.terminees} terminées</span></div>
        <div class="kpi"><span class="small muted">Chiffre d'affaires HT</span><b>${eur(k.caHT)}</b><span class="small muted">missions terminées</span></div>
        <div class="kpi"><span class="small muted">Marge estimée</span><b>${eur(k.marge)}</b><span class="small muted">${k.caHT ? Math.round((k.marge / k.caHT) * 100) : 0} % du CA</span></div>
        <div class="kpi"><span class="small muted">À rembourser</span><b>${eur(k.aRembourser.montant)}</b><span class="small muted">${k.aRembourser.n} réservation${k.aRembourser.n > 1 ? 's' : ''} annulée${k.aRembourser.n > 1 ? 's' : ''}</span></div>
        <div class="kpi"><span class="small muted">Note moyenne</span><b>${k.noteMoyenne ? String(k.noteMoyenne).replace('.', ',') + ' / 5' : '–'}</b><span class="small muted">${k.clients} client${k.clients > 1 ? 's' : ''}</span></div>
      </div>
      <section class="card plan-card" data-tab="planning"><div id="plan"><p class="muted">Chargement du planning…</p></div><div id="planPick"></div></section>
      <section class="card" id="sec-table" data-tab="resa"><h2>Réservations</h2><div class="scroll"><table class="bk">
        <thead><tr><th>N°</th><th>Prestation</th><th>Date</th><th>Code postal</th><th>Intervenante</th><th>État</th><th class="n">Prix TTC</th><th>Paiement</th><th></th></tr></thead>
        <tbody>${r.bookings.map((b) => `<tr class="bkrow"><td data-l="N°"><b>n° ${b.id}</b></td><td data-l="Prestation">${esc(label(b))}${b.kit ? ' <span class="pill">matériel</span>' : ''}</td><td data-l="Date">${dateFr(b.date)} ${esc(b.time)}</td><td data-l="Code postal">${esc(b.cp)}</td>
          <td data-l="Intervenante">${b.worker_name ? esc(b.worker_name) : '<span class="muted">–</span>'}</td><td data-l="État">${pill(b.status)}${b.rating ? ' ' + '★'.repeat(b.rating) : ''}</td><td class="n" data-l="Prix TTC">${eur(b.total)}</td><td class="small" data-l="Paiement">${PAY[b.payment_status] || ''}</td>
          <td class="acts">${['en_attente', 'proposee', 'attribuee'].includes(b.status) && b.paid ? `<button class="btn ghost" data-pick="${b.id}">Choisir l'intervenante</button>` : ''}${b.worker_id && ['attribuee', 'en_cours'].includes(b.status) && b.date <= todayParis() ? `<button class="btn ghost warn-ghost" data-noshow="${b.id}">Absence non prévenue</button>` : ''}${owner && b.payment_status === 'a_rembourser' ? `<button class="btn blue" data-srefund="${b.id}" data-amount="${eur(b.refund_amount ?? b.total)}">Rembourser ${eur(b.refund_amount ?? b.total)}</button><button class="btn ghost" data-refund="${b.id}">Déjà remboursé dans Stripe</button>` : ''}<button class="btn ghost" data-cfile="${b.client_id}">Fiche client</button><button class="btn ghost" data-thread="${b.id}">Messages${b.messages ? ` (${b.messages})` : ''}</button></td></tr><tr class="threadrow"><td colspan="9" style="padding:0;border:0"><div id="thread-${b.id}"></div></td></tr>`).join('') || '<tr><td colspan="9" class="muted">Aucune réservation.</td></tr>'}</tbody>
      </table></div></section>
      ${r.incidents.length ? `<section class="card" id="sec-incidents" data-tab="todo"><h2>Problèmes signalés par les clients</h2>${r.incidents.map((x) => `
        <div class="row box" style="margin-top:8px"><div><b>Réservation n° ${x.booking_id}</b> · ${dateFr(x.date)} ${esc(x.time)} · ${esc(x.cp)}<br>${esc(x.text)}</div>
        <div class="row"><button class="btn ghost" data-thread="${x.booking_id}" data-inc>Écrire au client</button>${x.source === 'garantie' ? `<button class="btn blue" data-gvisit="${x.booking_id}">Planifier le retour</button>` : `<button class="btn blue" data-resolve="${x.id}">Marquer traité</button>`}</div></div>
        ${x.source === 'garantie' ? `<form class="box row gvisit-form" id="gv-${x.booking_id}" hidden style="flex-wrap:wrap;gap:10px;align-items:end"><label>Date<input type="date" name="date" required></label><label>Heure<input type="time" name="time" value="10:00" step="1800" required></label>
          <label>Durée (h)<input type="number" name="hours" min="1" max="8" step="0.5" value="2"></label><button class="btn blue">Créer le retour gratuit</button></form>` : ''}
        <div id="thread-inc-${x.booking_id}"></div>`).join('')}</section>` : ''}
      <section class="card" id="sec-team" data-tab="equipe"><h2>Équipe et recrutement</h2>
        <p class="small muted">Aucune mission avant le statut « Active ».</p>
        ${owner ? `<form id="admin-add-worker" class="card" style="margin:12px 0;padding:16px">
          <h3>Ajouter une intervenante réelle</h3>
          <div class="grid2">
            <label>Nom<input name="name" required maxlength="80" placeholder="Prénom et nom"></label>
            <label>E-mail<input name="email" type="email" required maxlength="120"></label>
            <label>Code postal<input name="cp" required maxlength="5" pattern="[0-9]{5}" placeholder="75011"></label>
            <label>Statut<select name="statut" id="admin-worker-statut"><option value="S">Salariée</option><option value="I">Indépendante</option></select></label>
            <label>Téléphone<input name="phone" maxlength="20"></label>
            <label>Tarif horaire (indépendante)<input name="rate" type="number" min="15" max="40" step="0.5" placeholder="22"></label>
            <label>Mot de passe provisoire (10 caractères min.)<input name="password" type="password" minlength="10" required autocomplete="new-password"></label>
          </div>
          <p class="small muted">Le compte commence à l'étape « Inscription ». Vérifiez réellement les documents avant d'activer une intervenante.</p>
          <button class="btn blue" type="submit">Créer le compte intervenante</button>
        </form>
        <div class="card" style="margin:12px 0;padding:16px"><h3>Profils de démonstration</h3>
          <p class="small muted">Cinq profils fictifs marqués TEST, inactifs et absents. Ils ne doivent jamais être attribués à une mission réelle. Sur Render, autorisation temporaire ALLOW_DEMO_WORKERS=true nécessaire.</p>
          <button type="button" class="btn ghost" id="admin-demo-workers">Créer les 5 profils fictifs</button>
        </div>
        <details class="card" style="margin:12px 0;padding:16px" id="docsCfg"><summary>Pièces demandées aux intervenantes</summary><div id="docsCfgBody" class="stack"><p class="muted small">Chargement…</p></div></details>
        <details class="card" style="margin:12px 0;padding:16px" id="staffBox"><summary>Comptes de l'équipe</summary>
          <p class="small muted">Un compte « planning » voit le planning, les réservations, l'équipe et les messages. Il ne voit ni les chiffres, ni les coordonnées complètes, et ne peut pas rembourser.</p>
          <ul class="plain small" id="staffList"><li class="muted">Chargement…</li></ul>
          <form id="staffForm" class="grid2" style="gap:10px;margin-top:10px">
            <label>Nom<input name="name" required maxlength="80"></label>
            <label>E-mail<input name="email" type="email" required maxlength="120"></label>
            <label>Mot de passe provisoire (12 caractères min.)<input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
            <button class="btn blue" style="align-self:end">Créer un compte planning</button>
          </form>
        </details>` : ''}
        <div class="grid2" style="gap:12px">${r.workers.map((w) => `
          <div class="card" style="margin:0">
            <div class="row"><span class="who-line" style="margin:0">${avatar(w.user_id, Boolean(w.avatar), w.name, 'sm')}<b>${esc(w.name)}</b></span><span class="row" style="gap:6px"><span class="pill">${w.statut === 'S' ? 'Salariée' : 'Indépendante'}</span>${w.tier ? `<span class="tier-pill ${w.tier.key}" title="Niveau">${w.tier.icon} ${esc(w.tier.label)}</span>` : ''}<button class="btn ghost small-btn" data-wfile="${w.user_id}">Fiche</button></span></div>
            <span class="small muted">${esc(w.cp)}${w.rate ? ' · ' + eur(w.rate) + '/h' : ''} · ${esc(w.email)}</span>
            ${w.avatar_status === 'a_verifier' ? `<div class="av-check"><img src="/api/workers/${w.user_id}/avatar" alt="Photo envoyée par ${esc(w.name)}"><div><b>📷 Nouvelle photo à vérifier</b><p class="small muted" style="margin:2px 0 6px">Visage net, de face, photo correcte ?</p><span class="row" style="gap:6px;justify-content:flex-start"><button class="btn blue small-btn" data-avok="${w.user_id}">✅ Accepter</button><button class="btn ghost small-btn" data-avno="${w.user_id}">✖️ Refuser</button></span></div></div>` : ''}
            <div class="prog"><i style="width:${(w.step / (w.steps.length - 1)) * 100}%"></i></div>
            ${w.docs && !w.active && !w.rejected ? `<p class="small" style="margin:6px 0 0">Pièces : ${w.docs.valid}/${w.docs.required} validées${w.docs.toCheck ? ` · <span class="pill warn">${w.docs.toCheck} à vérifier</span>` : ''}</p>` : ''}
            <div class="row"><span class="small">${w.rejected ? '<span class="pill">Candidature refusée</span>' : w.active ? (w.absent ? '<span class="pill warn">Absente</span>' : '<span class="pill ok">Active</span>') : 'À valider : ' + esc(w.steps[w.step + 1])}</span>
            ${w.rejected ? '' : w.active ? `<button class="btn ghost" data-absent="${w.user_id}">${w.absent ? 'Marquer présente' : 'Marquer absente'}</button>` : `<button class="btn ghost" data-advance="${w.user_id}">Valider l'étape</button>`}</div>
          </div>`).join('')}</div></section>
      <div class="panes">
        <section class="card" data-tab="chiffres"><h2>Liste d'attente</h2><p class="small muted">Demandes hors zone ouverte, par département.</p>
          <div class="chips">${r.waitlist.map((x) => `<span class="pill">${esc(x.dept)} · ${x.n}</span>`).join('') || '<span class="muted">Aucune demande.</span>'}</div></section>
        <section class="card" data-tab="suivi"><h2>E-mails envoyés</h2><p class="small muted">${ob.provider ? `Envoi réel via ${esc(ob.provider)}.` : 'Mode local : les e-mails ne partent pas, ils sont enregistrés ici pour vérification.'}</p>
          ${ob.queue && ob.queue.attente ? `<p class="msg warn">${ob.queue.attente} e-mail(s) en attente : nouvel essai automatique toutes les 5 minutes.</p>` : ''}
          ${ob.queue && ob.queue.abandon ? `<p class="msg warn">${ob.queue.abandon} e-mail(s) abandonné(s) après plusieurs essais : détails dans le journal.</p>` : ''}
          <ul class="plain small">${ob.list.slice(0, 12).map((m) => `<li><span>${esc(m.subject)}<br><span class="muted">${esc(m.to)}</span></span><a href="/api/admin/outbox/${encodeURIComponent(m.file)}" target="_blank" rel="noopener">Ouvrir</a></li>`).join('') || '<li class="muted">Aucun e-mail.</li>'}</ul></section>
        <section class="card" data-tab="suivi"><h2>Sauvegardes</h2>
          ${bk.enabled ? `<p class="small muted">Une sauvegarde automatique par jour ; les 14 dernières sont gardées sur le serveur.</p>
          ${bk.error ? `<p class="msg warn">Dernière sauvegarde en échec : ${esc(bk.error)}</p>` : ''}
          ${bk.verify && bk.verify.ok ? `<p class="small">Dernière copie vérifiée : elle s'ouvre et contient ${bk.verify.users} comptes et ${bk.verify.bookings} réservations.</p>` : ''}
          ${!bk.offsite || !bk.offsite.configured ? '<p class="msg warn">Pas de copie hors de Render : si le disque est perdu, les sauvegardes le sont aussi. Configurez le stockage externe (voir SAUVEGARDES.md).</p>'
            : bk.offsite.ok ? `<p class="small">Copie externe chiffrée envoyée le ${new Date(bk.offsite.at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' })}.</p>`
            : bk.offsite.ok === false ? `<p class="msg warn">Copie externe en échec : ${esc(bk.offsite.error || '')}</p>` : '<p class="small muted">Copie externe : envoi à la prochaine sauvegarde.</p>'}
          <ul class="plain small">${bk.list.map((x) => `<li><span>${new Date(x.time).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' })}</span><span class="muted">${Math.max(1, Math.round(x.size / 1024))} Ko</span></li>`).join('') || '<li class="muted">Aucune sauvegarde pour le moment.</li>'}</ul>
          <button class="btn ghost" id="doBackup">Sauvegarder maintenant</button>
          ${bk.download ? '<a class="btn ghost" href="/api/admin/backups/latest" download>Télécharger la dernière (chiffrée)</a>' : ''}` : '<p class="small muted">Sauvegardes désactivées.</p>'}</section>
        ${r.couts ? `<section class="card" data-tab="chiffres"><h2>Hypothèses de marge</h2><p class="small muted">La marge est une estimation. Ces valeurs sont dans le fichier <b>config/couts.json</b> : faites-les valider par votre expert-comptable puis modifiez-les si besoin (redémarrage nécessaire).</p>
          <ul class="small"><li>Coût d'une salariée par heure facturée : ${eur(r.couts.salarieeParHeureFacturee)}</li><li>TVA particuliers : ${Math.round(r.couts.tvaParticulier * 100)} % · professionnels : ${Math.round(r.couts.tvaPro * 100)} %</li><li>Produits par mission : ${eur(r.couts.produits)} · matériel fourni : ${eur(r.couts.kitCout)}</li></ul></section>` : ''}
        <section class="card" data-tab="suivi" id="journal"><h2>Journal</h2>
          <div class="grid2" style="gap:10px">
            <label>Type<select id="jType"><option value="">Tout</option>${Object.entries(EVENT_TYPES).map(([k, [t]]) => `<option value="${k}">${t}</option>`).join('')}</select></label>
            <label>Réservation n°<input type="text" id="jBk" inputmode="numeric" maxlength="6" placeholder="ex. 12"></label>
          </div>
          <ul class="log" id="jList"></ul><p class="small muted" id="jMore"></p>
        </section>
      </div>`;
    const bind = (attr, path) => $app.querySelectorAll(`[${attr}]`).forEach((btn) => btn.onclick = async () => {
      btn.disabled = true;
      try { const r = await api('POST', path(btn.getAttribute(attr)), {}); if (r && r.message) toast(r.message); route(); } catch (e) { toast(e.message); btn.disabled = false; }
    });
    const addWorker = document.getElementById('admin-add-worker');
    if (addWorker) addWorker.onsubmit = async (e) => {
      e.preventDefault();
      const btn = addWorker.querySelector('[type="submit"]'); btn.disabled = true;
      try {
        const data = Object.fromEntries(new FormData(addWorker).entries());
        const r2 = await api('POST', '/api/admin/workers', data);
        toast(r2.message || 'Intervenante créée : validation nécessaire.'); route();
      } catch (err) { toast(err.message); btn.disabled = false; }
    };
    const demoBtn = document.getElementById('admin-demo-workers');
    if (demoBtn) demoBtn.onclick = async () => {
      if (!confirm('Créer 5 profils fictifs inactifs ? Ne pas les attribuer à de vrais clients.')) return;
      demoBtn.disabled = true;
      try { const result = await api('POST', '/api/admin/workers/demo', {}); toast(result.message); route(); }
      catch (err) { toast(err.message); demoBtn.disabled = false; }
    };
    bind('data-advance', (id) => `/api/admin/workers/${id}/advance`);
    bind('data-absent', (id) => `/api/admin/workers/${id}/absent`);
    bind('data-refund', (id) => `/api/admin/bookings/${id}/refunded`);
    const openFile = async (kind, id) => {
      let dlg = document.getElementById('fileDlg');
      if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'fileDlg'; dlg.className = 'file-dlg'; document.body.appendChild(dlg); }
      dlg.innerHTML = '<p class="muted">Chargement…</p>';
      if (!dlg.open) dlg.showModal();
      let d;
      try { d = await api('GET', kind === 'client' ? `/api/admin/clients/${id}` : `/api/admin/workers/${id}/file`); } catch (e) { dlg.innerHTML = `<p class="err">${esc(e.message)}</p><button class="btn ghost" data-close>Fermer</button>`; dlg.querySelector('[data-close]').onclick = () => dlg.close(); return; }
      const notes = `<h3>Notes de l'équipe</h3>
        <form class="note-form"><textarea name="text" rows="2" maxlength="1000" placeholder="Ex. préfère le matin, code d'accès changé…" aria-label="Nouvelle note"></textarea>
          ${kind === 'client' ? '<label class="check small"><input type="checkbox" name="share"> Montrer aussi à l\'intervenante de ses ménages (jamais au client)</label>' : ''}<button class="btn blue">Ajouter</button></form>
        <ul class="plain small">${d.notes.map((n) => `<li><span>${esc(n.text)}<br><span class="muted">${esc(n.author)} · ${new Date(n.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('fr-FR')}</span>${kind === 'client' ? ` · <button type="button" class="linkish small" data-nshare="${n.id}" data-on="${n.share ? 0 : 1}">${n.share ? '👁️ Visible par l\'intervenante · masquer' : 'Équipe seulement · montrer à l\'intervenante'}</button>` : ''}</span></li>`).join('') || '<li class="muted">Aucune note.</li>'}</ul>`;
      if (kind === 'client') {
        const c = d.client;
        dlg.innerHTML = `<div class="dlg-head"><h2>${esc(c.name)}</h2><button class="btn ghost" data-close aria-label="Fermer">✕</button></div>
          <p class="muted small">Client depuis ${new Date(c.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}${c.email ? ` · ${esc(c.email)}` : ''}${c.phone ? ` · ${esc(c.phone)}` : ''}${c.referred_by ? ' · venu par parrainage' : ''}</p>
          <div class="gain-grid"><div class="gain"><span>Ménages</span><b>${d.stats.menages}</b></div><div class="gain"><span>Annulés</span><b>${d.stats.annules}</b></div>${d.stats.depense !== null ? `<div class="gain"><span>Dépensé</span><b>${eur(d.stats.depense)}</b></div>` : ''}</div>
          ${d.homes.length ? `<p class="small" style="margin-top:10px"><b>Logements :</b> ${d.homes.map((h) => esc(h.name)).join(', ')}</p>` : ''}
          <h3>Historique</h3><ul class="plain small">${d.bookings.slice(0, 12).map((b) => `<li><span>n° ${b.id} · ${dateFr(b.date)} ${esc(b.time)} · ${esc(label(b))}${b.rating ? ` · ${'★'.repeat(b.rating)}` : ''}${b.review ? `<br><span class="muted">« ${esc(b.review)} »</span>` : ''}</span>${pill(b.status)}</li>`).join('')}</ul>${notes}`;
      } else {
        const w = d.worker;
        dlg.innerHTML = `<div class="dlg-head"><h2>${esc(w.name)}</h2><button class="btn ghost" data-close aria-label="Fermer">✕</button></div>
          <p class="muted small">${w.statut === 'S' ? 'Salariée' : `Indépendante · ${eur(w.rate)}/h`} · ${esc(w.cp)}${w.email ? ` · ${esc(w.email)}` : ''}${w.phone ? ` · ${esc(w.phone)}` : ''}${w.languages ? ` · parle ${esc(w.languages)}` : ''}</p>
          ${w.statut === 'I' && owner ? `<form class="row rate-form" style="justify-content:flex-start;gap:8px;align-items:end;margin:6px 0 10px"><label class="small">Tarif horaire<input name="rate" type="number" min="15" max="40" step="0.5" value="${w.rate}" style="width:110px"></label><button class="btn ghost small-btn">Changer le tarif</button><span class="small muted">Uniquement avec son accord : elle est prévenue par e-mail.</span></form>` : ''}
          <div class="gain-grid"><div class="gain"><span>Missions</span><b>${d.stats.missions}</b><small>${String(d.stats.heures).replace('.', ',')} h</small></div><div class="gain"><span>Note</span><b>${d.stats.note ? String(d.stats.note).replace('.', ',') + ' / 5' : '–'}</b><small>${d.stats.avis} avis</small></div><div class="gain"><span>Refus · problèmes</span><b>${d.stats.refus} · ${d.stats.problemes}</b></div></div>
          ${d.lowRatings.length ? `<h3>Notes basses à suivre</h3><ul class="plain small">${d.lowRatings.map((x) => `<li><span>n° ${x.id} · ${dateFr(x.date)} · ${'★'.repeat(x.rating)}${x.review ? `<br><span class="muted">« ${esc(x.review)} »</span>` : ''}</span></li>`).join('')}</ul>` : ''}
          <h3>Prochaines missions</h3><ul class="plain small">${d.upcoming.map((x) => `<li><span>n° ${x.id} · ${dateFr(x.date)} ${esc(x.time)} · ${esc(x.cp)}</span></li>`).join('') || '<li class="muted">Aucune.</li>'}</ul>
          ${d.rejected ? `<p class="msg warn">Candidature refusée le ${new Date(d.rejected.at.replace(' ', 'T') + 'Z').toLocaleDateString('fr-FR')}${d.rejected.reason ? ` : ${esc(d.rejected.reason)}` : ''}.</p>` : ''}
          ${d.documents ? `<h3>Pièces justificatives</h3>
            <p class="small ${d.documents.complete ? '' : 'muted'}">${d.documents.complete ? '<span class="pill ok">Toutes les pièces obligatoires sont validées</span>' : (d.documents.missing.length ? `Manque encore : ${d.documents.missing.map(esc).join(' ; ')}.` : '')}${d.documents.expired && d.documents.expired.length ? ` <span class="pill warn">Expiré : ${d.documents.expired.map(esc).join(' ; ')} · plus de nouvelles missions</span>` : ''}</p>
            <ul class="plain small doc-list">${d.documents.list.map((k) => `<li><span><b>${esc(k.label)}</b>${k.required ? '' : ' (facultatif)'}<br>${k.latest
              ? `<span class="pill ${DOC_STATUS[k.latest.status][1]}">${DOC_STATUS[k.latest.status][0]}</span> déposé le ${new Date(k.latest.uploaded_at.replace(' ', 'T') + 'Z').toLocaleDateString('fr-FR')}${k.latest.note ? ` · ${esc(k.latest.note)}` : ''}${k.valid_until ? `<br><span class="${k.expired ? 'err' : k.soon ? 'warn-text' : 'muted'}">${k.expired ? '⚠️ Expiré' : 'Valable'} jusqu'au ${dayFr(k.valid_until)}</span>` : ''}`
              : '<span class="muted">Pas encore déposé</span>'}</span>
              ${k.latest ? `<span class="row" style="gap:6px;flex-wrap:wrap"><a class="btn ghost small-btn" href="/api/documents/${k.latest.id}" target="_blank" rel="noopener">Ouvrir</a>
                ${k.latest.status !== 'valide' ? `${k.expiring ? `<label class="small">Valable jusqu'au<input type="date" data-docexp="${k.latest.id}" value="${esc(k.latest.expires_on || '')}"></label>` : ''}<button class="btn blue small-btn" data-docok="${k.latest.id}">Valider</button>` : ''}${k.latest.status !== 'refuse' ? `<button class="btn ghost small-btn" data-docko="${k.latest.id}">Refuser</button>` : ''}</span>` : ''}</li>`).join('')}</ul>
            <form class="stack" id="docRefuse" hidden><label>Raison du refus (envoyée à l'intervenante)<input name="note" maxlength="300" placeholder="Ex. photo floue, attestation de plus de 6 mois" required></label>
              <div class="row" style="justify-content:flex-start"><button class="btn blue">Refuser ce document</button><button type="button" class="btn ghost" data-cancelref>Annuler</button></div></form>` : ''}
          ${d.documents && !d.rejected && w.step < w.steps.length - 1 ? `<details class="card" style="margin-top:12px;padding:14px"><summary>Refuser la candidature</summary>
            <form class="stack" id="rejectForm"><label>Raison (interne, non envoyée)<input name="reason" maxlength="300" required placeholder="Ex. entretien non concluant"></label>
            <p class="small muted">La candidate reçoit un message neutre. Ses documents sont supprimés 30 jours après.</p>
            <button class="btn ghost">Confirmer le refus</button></form></details>` : ''}
          ${notes}`;
      }
      dlg.querySelector('[data-close]').onclick = () => dlg.close();
      dlg.querySelectorAll('[data-docok]').forEach((b) => b.onclick = async () => {
        const exp = dlg.querySelector(`[data-docexp="${b.dataset.docok}"]`);
        try { const r2 = await api('POST', `/api/admin/documents/${b.dataset.docok}/review`, { decision: 'valide', expires_on: exp && exp.value ? exp.value : undefined }); toast(r2.message); openFile(kind, id); } catch (err) { toast(err.message); }
      });
      const refForm = dlg.querySelector('#docRefuse');
      dlg.querySelectorAll('[data-docko]').forEach((b) => b.onclick = () => { refForm.hidden = false; refForm.dataset.doc = b.dataset.docko; refForm.note.focus(); });
      if (refForm) {
        refForm.querySelector('[data-cancelref]').onclick = () => { refForm.hidden = true; };
        refForm.onsubmit = async (e) => {
          e.preventDefault();
          try { const r2 = await api('POST', `/api/admin/documents/${refForm.dataset.doc}/review`, { decision: 'refuse', note: refForm.note.value }); toast(r2.message); openFile(kind, id); } catch (err) { toast(err.message); }
        };
      }
      dlg.querySelectorAll('[data-nshare]').forEach((b) => b.onclick = async () => {
        try { const r2 = await api('POST', `/api/admin/notes/${b.dataset.nshare}/share`, { share: b.dataset.on === '1' }); toast(r2.message); openFile(kind, id); } catch (err) { toast(err.message); }
      });
      const rf = dlg.querySelector('.rate-form');
      if (rf) rf.onsubmit = async (e) => {
        e.preventDefault();
        if (!confirm(`Passer son tarif à ${rf.rate.value} € de l'heure ? Faites-le seulement si elle est d'accord.`)) return;
        try { const r2 = await api('POST', `/api/admin/workers/${id}/rate`, { rate: Number(rf.rate.value) }); toast(r2.message); openFile(kind, id); } catch (err) { toast(err.message); }
      };
      const rej = dlg.querySelector('#rejectForm');
      if (rej) rej.onsubmit = async (e) => {
        e.preventDefault();
        try { const r2 = await api('POST', `/api/admin/workers/${id}/reject`, { reason: rej.reason.value }); toast(r2.message); dlg.close(); route(); } catch (err) { toast(err.message); }
      };
      dlg.querySelector('.note-form').onsubmit = async (e) => {
        e.preventDefault();
        try { const r2 = await api('POST', '/api/admin/notes', { kind: kind === 'client' ? 'client' : 'worker', target_id: id, text: e.target.text.value, share: Boolean(e.target.share && e.target.share.checked) }); toast(r2.message); openFile(kind, id); } catch (err) { toast(err.message); }
      };
    };
    $app.querySelectorAll('[data-cfile]').forEach((b) => b.onclick = () => openFile('client', Number(b.dataset.cfile)));
    $app.querySelectorAll('[data-wfile]').forEach((b) => b.onclick = () => openFile('worker', Number(b.dataset.wfile)));
    $app.querySelectorAll('[data-avok], [data-avno]').forEach((b) => b.onclick = async () => {
      const id = b.dataset.avok || b.dataset.avno;
      try { const r2 = await api('POST', `/api/admin/workers/${id}/avatar`, { ok: Boolean(b.dataset.avok) }); toast(r2.message); route(); } catch (e) { toast(e.message); }
    });
    const od = document.getElementById('openDevis');
    if (od) od.onclick = async () => {
      let dlg = document.getElementById('fileDlg');
      if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'fileDlg'; dlg.className = 'file-dlg'; document.body.appendChild(dlg); }
      const list = await api('GET', '/api/admin/quote-requests');
      dlg.innerHTML = `<div class="dlg-head"><h2>Demandes de devis</h2><button class="btn ghost" data-close aria-label="Fermer">✕</button></div>
        <ul class="plain">${list.map((q) => `<li><span><b>${esc(q.company)}</b> · ${esc(q.kindLabel)} · ${esc(q.cp)}${q.surface ? ` · ${q.surface} m²` : ''}${q.frequency ? ` · ${esc(q.frequency)}` : ''}<br><span class="small">${esc(q.name)} · <a href="mailto:${esc(q.email)}">${esc(q.email)}</a>${q.phone ? ` · <a href="tel:${esc(q.phone)}">${esc(q.phone)}</a>` : ''}</span>${q.message ? `<br><span class="small muted">${esc(q.message)}</span>` : ''}</span>${q.status === 'nouveau' ? `<button class="btn ghost small-btn" data-qdone="${q.id}">Traitée</button>` : '<span class="pill ok">Traitée</span>'}</li>`).join('') || '<li class="muted">Aucune demande.</li>'}</ul>`;
      if (!dlg.open) dlg.showModal();
      dlg.querySelector('[data-close]').onclick = () => { dlg.close(); route(); };
      dlg.querySelectorAll('[data-qdone]').forEach((b) => b.onclick = async () => { await api('POST', `/api/admin/quote-requests/${b.dataset.qdone}/done`, {}); b.replaceWith(Object.assign(document.createElement('span'), { className: 'pill ok', textContent: 'Traitée' })); });
    };
    const pb = document.getElementById('payoutsBox');
    const paintPayouts = async () => {
      const d = await api('GET', '/api/admin/payouts').catch(() => null);
      if (!d || !pb) return;
      pb.innerHTML = `<h2>À verser aux indépendantes</h2>
        <p class="small muted">Ménages terminés, par semaine, au tarif de chaque indépendante, bonus Platine et pourboires compris. Faites le virement depuis votre banque, puis marquez-le ici : l'intervenante est prévenue par e-mail.</p>
        ${d.owed.some((o) => o.weekOver && o.iban) ? `<div class="row" style="justify-content:flex-start;gap:8px;flex-wrap:wrap;margin:0 0 10px">
          <a class="btn blue" href="/api/admin/payouts/sepa.xml" download>⬇️ Fichier de virements groupés (SEPA)</a>
          <button class="btn ghost" id="sepaDone">J'ai fait le virement : tout marquer versé</button></div>
          <p class="small muted" style="margin:0 0 10px">Importez le fichier dans votre banque en ligne (rubrique « virements groupés » ou « remise de virements »), validez-le, puis marquez les versements comme faits. Seules les semaines terminées avec un IBAN sont dans le fichier.</p>` : ''}
        ${d.owed.length ? `<p style="margin:0 0 6px"><b>Total à verser : ${eur(d.total)}</b></p><ul class="plain">${d.owed.map((o) => `<li><span><b>${esc(o.name)}</b> ${o.iban ? `<span class="small muted">${esc(o.iban)}</span>` : '<span class="pill warn">pas d\'IBAN</span>'}${o.tips ? ` <span class="small">💝 dont ${eur(o.tips)} de pourboires</span>` : ''} · semaine du ${dateFr(o.week_start)}${o.weekOver ? '' : ' <span class="pill">en cours</span>'}<br><span class="small muted">${String(o.hours).replace('.', ',')} h × ${eur(o.rate)}${o.bonus_rate ? ` + bonus ${eur(o.bonus_rate)}/h` : ''} = <b>${eur(o.amount)}</b></span></span>
          <form class="pay-form" data-w="${o.worker_id}" data-week="${o.week_start}"><input name="reference" maxlength="60" placeholder="Réf. du virement" aria-label="Référence du virement"><button class="btn blue small-btn">Marquer versé</button></form></li>`).join('')}</ul>` : '<p class="msg ok">Rien à verser pour le moment.</p>'}
        ${d.history.length ? `<h3>Derniers versements</h3><ul class="plain small">${d.history.map((h) => `<li><span>${esc(h.name)} · semaine du ${dateFr(h.week_start)}${h.reference ? ` · ${esc(h.reference)}` : ''}</span><b>${eur(h.amount)}</b></li>`).join('')}</ul>` : ''}`;
      const sd = document.getElementById('sepaDone');
      if (sd) sd.onclick = async () => {
        const ready = d.owed.filter((o) => o.weekOver && o.iban && o.amount > 0);
        if (!confirm(`Marquer ${ready.length} versement(s) comme faits, pour ${eur(ready.reduce((t, o) => t + o.amount, 0))} ? Chaque intervenante reçoit un e-mail.`)) return;
        const ref = `Virement groupé du ${new Date().toLocaleDateString('fr-FR')}`;
        for (const o of ready) { try { await api('POST', '/api/admin/payouts', { worker_id: o.worker_id, week_start: o.week_start, reference: ref }); } catch (err) { toast(err.message); } }
        toast('Versements marqués comme faits.'); paintPayouts();
      };
      pb.querySelectorAll('.pay-form').forEach((f) => f.onsubmit = async (e) => {
        e.preventDefault();
        try { const r = await api('POST', '/api/admin/payouts', { worker_id: Number(f.dataset.w), week_start: f.dataset.week, reference: f.reference.value }); toast(r.message); paintPayouts(); } catch (err) { toast(err.message); }
      });
    };
    if (pb) paintPayouts();
    // ---- liste des pièces demandées, modifiable ----
    const docsCfg = document.getElementById('docsCfg');
    const paintDocsCfg = async (list) => {
      const body = document.getElementById('docsCfgBody');
      let d;
      try { d = await api('GET', '/api/admin/worker-docs'); } catch (e) { body.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
      const rows = list || d.list;
      const row = (x, i) => `<li class="doc-cfg" data-i="${i}" data-kind="${esc(x.kind || '')}">
          <input name="label" value="${esc(x.label)}" maxlength="140" aria-label="Nom de la pièce" placeholder="Ex. justificatif de domicile">
          <span class="row" style="gap:12px;flex-wrap:wrap;justify-content:flex-start">
            <label class="check"><input type="checkbox" name="S" ${x.for.includes('S') ? 'checked' : ''}> Salariée</label>
            <label class="check"><input type="checkbox" name="I" ${x.for.includes('I') ? 'checked' : ''}> Indépendante</label>
            <label class="check"><input type="checkbox" name="required" ${x.required ? 'checked' : ''}> Obligatoire</label>
            <button type="button" class="btn ghost small-btn" data-delrow="${i}">Retirer</button></span></li>`;
      body.innerHTML = `<p class="small muted">Ce que chaque candidate doit déposer avant d'être activée. Une pièce obligatoire non validée bloque l'activation. Les pièces déjà validées restent valables.</p>
        <ul class="plain" id="docsCfgList">${rows.map(row).join('')}</ul>
        <div class="row" style="justify-content:flex-start;gap:10px;flex-wrap:wrap"><button type="button" class="btn ghost" id="docsCfgAdd">Ajouter une pièce</button>
          <button type="button" class="btn blue" id="docsCfgSave">Enregistrer la liste</button><button type="button" class="btn ghost" id="docsCfgReset">Revenir à la liste d'origine</button></div>`;
      const read = () => [...body.querySelectorAll('.doc-cfg')].map((li) => ({ kind: li.dataset.kind || undefined, label: li.querySelector('[name="label"]').value.trim(),
        for: ['S', 'I'].filter((x) => li.querySelector(`[name="${x}"]`).checked), required: li.querySelector('[name="required"]').checked }));
      body.querySelectorAll('[data-delrow]').forEach((b) => b.onclick = () => { const cur = read(); cur.splice(Number(b.dataset.delrow), 1); paintDocsCfg(cur); });
      document.getElementById('docsCfgAdd').onclick = () => { paintDocsCfg([...read(), { label: '', for: ['S', 'I'], required: true }]); };
      document.getElementById('docsCfgReset').onclick = () => { paintDocsCfg(d.defaults); toast('Liste d\'origine remise : enregistrez pour l\'appliquer.'); };
      document.getElementById('docsCfgSave').onclick = async () => {
        try { const r2 = await api('POST', '/api/admin/worker-docs', { list: read().filter((x) => x.label) }); toast(r2.message); paintDocsCfg(); } catch (e) { toast(e.message); }
      };
    };
    if (docsCfg) docsCfg.addEventListener('toggle', () => { if (docsCfg.open && !docsCfg.dataset.done) { docsCfg.dataset.done = '1'; paintDocsCfg(); } });
    const staffBox = document.getElementById('staffBox');
    if (staffBox) {
      staffBox.addEventListener('toggle', async () => {
        if (!staffBox.open) return;
        const list = await api('GET', '/api/admin/staff').catch(() => []);
        document.getElementById('staffList').innerHTML = list.map((u) => `<li><span>${esc(u.name)}<br><span class="muted">${esc(u.email)}</span></span><span class="pill">${u.level === 'planning' ? 'Planning' : 'Responsable'}</span></li>`).join('');
      });
      document.getElementById('staffForm').onsubmit = async (e) => {
        e.preventDefault();
        try { const res = await api('POST', '/api/admin/staff', formData(e.target)); toast(res.message); e.target.reset(); staffBox.open = false; staffBox.open = true; } catch (err) { toast(err.message); }
      };
    }
    $app.querySelectorAll('[data-srefund]').forEach((btn) => btn.onclick = async () => {
      if (!confirm(`Rembourser ${btn.dataset.amount} au client par Stripe ? L'argent part tout de suite sur sa carte.`)) return;
      btn.disabled = true;
      try { const r = await api('POST', `/api/admin/bookings/${btn.dataset.srefund}/refund`, {}); toast(r.message); route(); }
      catch (e) { toast(e.message); btn.disabled = false; }
    });
    bind('data-resolve', (id) => `/api/admin/incidents/${id}/resolve`);
    $app.querySelectorAll('[data-gvisit]').forEach((b) => b.onclick = () => {
      const f = document.getElementById(`gv-${b.dataset.gvisit}`);
      f.hidden = !f.hidden;
      if (!f.hidden) f.date.min = new Date().toISOString().slice(0, 10);
      f.onsubmit = async (e) => {
        e.preventDefault();
        try { const r2 = await api('POST', `/api/admin/bookings/${b.dataset.gvisit}/guarantee-visit`, { date: f.date.value, time: f.time.value, hours: Number(f.hours.value) }); toast(r2.message); route(); } catch (err) { toast(err.message); }
      };
    });
    const cents = (c) => eur(Math.round(c) / 100);
    const monthName = (m) => new Date(m + '-15T12:00:00Z').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    // ---- statistiques par mois ----
    const paintStats = async () => {
      const box = document.getElementById('statsBox');
      if (!box || box.dataset.done) return;
      let d;
      try { d = await api('GET', '/api/admin/stats?months=12'); } catch (e) { box.innerHTML = `<h2>Statistiques par mois</h2><p class="err">${esc(e.message)}</p>`; return; }
      box.dataset.done = '1';
      const max = Math.max(1, ...d.rows.map((r2) => r2.netTTC));
      box.innerHTML = `<h2>Statistiques par mois</h2>
        <p class="small muted">${d.theoretical ? 'Paiement simulé : chiffre d\'affaires théorique, calculé sur les ménages terminés.' : 'Chiffre d\'affaires tiré des factures (paiements encaissés) moins les avoirs (remboursements).'} Taux d'annulation : réservations annulées sur les réservations du mois (paiements abandonnés exclus).</p>
        <div class="kpis"><div class="kpi"><span>CA net TTC, 12 mois</span><b>${cents(d.total.netTTC)}</b></div><div class="kpi"><span>CA net HT</span><b>${cents(d.total.netHT)}</b></div>
          <div class="kpi"><span>Ménages réalisés</span><b>${d.total.prestations}</b></div><div class="kpi"><span>Taux d'annulation</span><b>${d.total.tauxAnnulation === null ? '–' : String(d.total.tauxAnnulation).replace('.', ',') + ' %'}</b></div></div>
        <div class="bars" role="img" aria-label="Chiffre d'affaires net TTC par mois">${d.rows.map((r2) => `<div class="bar"><i style="height:${Math.round((r2.netTTC / max) * 100)}%" title="${esc(monthName(r2.month))} : ${esc(cents(r2.netTTC))}"></i><span>${r2.month.slice(5)}</span></div>`).join('')}</div>
        <div class="table-wrap"><table class="stats"><thead><tr><th>Mois</th><th class="n">CA net TTC</th><th class="n">Remboursé</th><th class="n">CA net HT</th><th class="n">Ménages</th><th class="n">Heures</th><th class="n">Annulations</th><th class="n">Panier moyen</th><th class="n">Nouveaux clients</th><th class="n">Clients actifs</th></tr></thead>
        <tbody>${d.rows.slice().reverse().map((r2) => `<tr><td>${esc(monthName(r2.month))}</td><td class="n"><b>${cents(r2.netTTC)}</b></td><td class="n">${r2.rembourse ? cents(r2.rembourse) : '–'}</td><td class="n">${cents(r2.netHT)}</td><td class="n">${r2.prestations}</td><td class="n">${String(r2.heures).replace('.', ',')}</td>
          <td class="n">${r2.annulees}${r2.tauxAnnulation === null ? '' : ` (${String(r2.tauxAnnulation).replace('.', ',')} %)`}</td><td class="n">${r2.panierMoyen === null ? '–' : cents(r2.panierMoyen)}</td><td class="n">${r2.nouveauxClients}</td><td class="n">${r2.clientsActifs}</td></tr>`).join('')}</tbody></table></div>
        ${d.services.length ? `<h3>Par prestation, sur 12 mois</h3><ul class="plain small">${d.services.map((x) => `<li><span>${esc(x.label)}</span><b>${cents(x.cents)}</b></li>`).join('')}</ul>` : ''}`;
    };
    // ---- paiements, remboursements, contestations ----
    const paintPayments = async (month) => {
      const box = document.getElementById('payBox');
      if (!box) return;
      let d;
      try { d = await api('GET', `/api/admin/payments${month ? `?month=${month}` : ''}`); } catch (e) { box.innerHTML = `<h2>Paiements et remboursements</h2><p class="err">${esc(e.message)}</p>`; return; }
      const open = d.disputes.filter((x) => x.open);
      box.innerHTML = `<h2>Paiements et remboursements</h2>
        ${d.disputes.length ? `<div class="card ${open.length ? 'dispute-open' : ''}" style="margin:0 0 14px;padding:14px"><h3>Contestations bancaires${open.length ? ` · <span class="pill warn">${open.length} à traiter</span>` : ''}</h3>
          <ul class="plain small">${d.disputes.map((x) => `<li><span><b>${cents(x.amount_cents)}</b> · ${esc(x.reason)} · <span class="pill ${x.status === 'won' ? 'ok' : x.open ? 'warn' : ''}">${esc(x.statusLabel)}</span>${x.due_by && x.open ? ` · <b>réponse avant le ${new Date(x.due_by).toLocaleDateString('fr-FR')}</b>` : ''}<br>
            <span class="muted">${x.client ? esc(x.client) + ' · ' : ''}${x.bookings.length ? `réservation n° ${x.bookings.join(', ')}` : 'réservation non retrouvée'}</span></span>
            <span class="row" style="gap:6px;flex-wrap:wrap"><a class="btn ghost small-btn" href="/api/admin/disputes/${x.id}/evidence" target="_blank" rel="noopener">Dossier de preuve</a><a class="btn blue small-btn" href="${esc(x.stripeUrl)}" target="_blank" rel="noopener">Répondre dans Stripe</a></span></li>`).join('')}</ul></div>` : ''}
        <div class="row" style="justify-content:flex-start;align-items:end;gap:10px;flex-wrap:wrap"><label>Mois<input type="month" id="payMonth" value="${esc(d.month)}"></label>
          <a class="btn ghost" href="/api/admin/payments.csv?month=${esc(d.month)}" download>Paiements (CSV)</a>
          <a class="btn ghost" href="/api/admin/invoices.csv?month=${esc(d.month)}" download>Factures et avoirs (CSV)</a>
          <a class="btn ghost" href="/api/admin/invoices/print?month=${esc(d.month)}" target="_blank" rel="noopener">Toutes les factures du mois (PDF)</a>
          <a class="btn ghost" href="/api/admin/payroll.csv?month=${esc(d.month)}" download>Paie des salariées (CSV)</a></div>
        <p class="small muted" style="margin:6px 0 0">Pour le comptable : le tableau des factures et avoirs, toutes les pièces du mois sur une page à enregistrer en un seul PDF, et le tableau de paie des salariées (heures, dimanches et fériés, prime Platine, pourboires, absences, congés).</p>
        <div class="kpis"><div class="kpi"><span>Encaissé par carte</span><b>${cents(d.totals.encaisse)}</b></div><div class="kpi"><span>Crédit Proprigo utilisé</span><b>${cents(d.totals.credit)}</b></div>
          <div class="kpi"><span>Remboursé</span><b>${cents(d.totals.rembourse)}</b></div><div class="kpi"><span>Net encaissé</span><b>${cents(d.totals.net)}</b></div><div class="kpi"><span>Dont TVA (factures − avoirs)</span><b>${cents(d.totals.tva)}</b></div></div>
        ${d.rows.length ? `<div class="table-wrap"><table class="stats"><thead><tr><th>Date</th><th>Type</th><th>Pièce</th><th>Client</th><th class="n">Réserv.</th><th class="n">Montant</th><th>Détail</th></tr></thead><tbody>
          ${d.rows.map((r2) => `<tr><td>${new Date(r2.at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' })}</td><td>${esc(r2.type)}</td>
            <td>${r2.ref ? `<a href="/api/bookings/${r2.booking}/receipt${r2.type === 'Remboursement' ? `?doc=${encodeURIComponent(r2.ref)}` : ''}" target="_blank" rel="noopener">${esc(r2.ref)}</a>` : '–'}</td><td>${esc(r2.client)}</td><td class="n">${r2.booking ? `n° ${r2.booking}` : '–'}</td>
            <td class="n">${r2.amount_cents ? `<b>${cents(r2.amount_cents)}</b>` : '–'}</td><td class="small">${esc(r2.status)}${r2.credit_cents ? ` · dont ${cents(r2.credit_cents)} de crédit` : ''}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">Aucun mouvement ce mois-ci.</p>'}
        <p class="small muted">Chaque paiement a sa facture et chaque remboursement son avoir. Les doublons bloqués n'ont jamais été encaissés. Les contestations arrivent de Stripe si les événements « charge.dispute » sont cochés sur le webhook.</p>`;
      document.getElementById('payMonth').onchange = (e) => { if (e.target.value) paintPayments(e.target.value); };
    };
    // ---- avis : publiés avec l'accord du client, masquables en cas de contenu inapproprié ----
    const paintReviews = async () => {
      const box = document.getElementById('revBox');
      if (!box) return;
      let list;
      try { list = await api('GET', '/api/admin/reviews'); } catch (e) { box.innerHTML = `<h2>Avis des clients</h2><p class="err">${esc(e.message)}</p>`; return; }
      box.innerHTML = `<h2>Avis des clients</h2><p class="small muted">Seuls les avis dont l'auteur a donné son accord apparaissent sur l'accueil (dès 3 notes au total). Masquez un avis seulement s'il est injurieux ou donne des informations personnelles : masquer les avis négatifs serait trompeur.</p>
        ${list.length ? `<ul class="plain small">${list.map((r2) => `<li><span>${'★'.repeat(r2.rating)} · <b>${esc(r2.name)}</b> · ${dateFr(r2.date)}<br>« ${esc(r2.review)} »<br>
          <span class="muted">${r2.review_public ? (r2.review_hidden ? 'Masqué du site' : 'Publié sur le site') : 'Non publié (pas d\'accord du client)'}</span></span>
          ${r2.review_public ? `<button class="btn ghost small-btn" data-revhide="${r2.id}" data-hidden="${r2.review_hidden ? 0 : 1}">${r2.review_hidden ? 'Afficher' : 'Masquer'}</button>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Aucun avis écrit pour le moment.</p>'}`;
      box.querySelectorAll('[data-revhide]').forEach((b) => b.onclick = async () => {
        try { const r2 = await api('POST', `/api/admin/reviews/${b.dataset.revhide}`, { hidden: b.dataset.hidden === '1' }); toast(r2.message); paintReviews(); } catch (e) { toast(e.message); }
      });
    };
    // ---- niveaux des intervenantes : Bleu, Or, Platine ----
    const paintTiers = async () => {
      const box = document.getElementById('tierBox');
      if (!box) return;
      let d;
      try { d = await api('GET', '/api/admin/tiers'); } catch (e) { box.innerHTML = `<h2>Niveaux des intervenantes</h2><p class="err">${esc(e.message)}</p>`; return; }
      const row = (k, icon, label, perk) => `<fieldset class="tier-set"><legend>${icon} ${label} <span class="muted small">· ${d.counts[k]} intervenante${d.counts[k] > 1 ? 's' : ''}</span></legend>
          <label>Ménages terminés<input type="number" name="${k}.missions" min="1" max="10000" value="${d[k].missions}" required></label>
          <label>Note moyenne minimum<input type="number" name="${k}.rating" min="1" max="5" step="0.1" value="${d[k].rating}" required></label>
          <label>Bonus (€ de l'heure)<input type="number" name="${k}.bonus" min="0" max="20" step="0.5" value="${d[k].bonus}" required></label>
          <p class="small muted" style="grid-column:1/-1;margin:0">${perk}</p></fieldset>`;
      box.innerHTML = `<h2>Niveaux des intervenantes</h2>
        <p class="small muted">🔵 Bleu au départ. On monte avec le nombre de ménages terminés et la note moyenne des avis (comptée à partir de ${d.minRatings} avis, la plus mauvaise note étant mise de côté : un client difficile ne fait pas perdre un niveau). Avantages : badge visible des clients, priorité sur les missions à distance comparable (${d.priorityKm} km d'avance pour l'Or, ${d.priorityKm * 2} km pour le Platine), et le bonus ci-dessous.</p>
        <p class="small muted">🔵 Bleu : ${d.counts.bleu} intervenante${d.counts.bleu > 1 ? 's' : ''}</p>
        <form id="tierForm" class="stack">${row('or', '🥇', 'Or', 'Priorité sur les missions.')}${row('platine', '💎', 'Platine', "Priorité sur les missions et bonus à chaque heure. Exige aussi aucune absence non prévenue sur les 6 derniers mois. Pour une salariée, le bonus est à ajouter sur sa fiche de paie.")}
          <button class="btn blue">Enregistrer les niveaux</button></form>`;
      document.getElementById('tierForm').onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target.elements;
        const v = (k) => ({ missions: Number(f[`${k}.missions`].value), rating: Number(f[`${k}.rating`].value), bonus: Number(f[`${k}.bonus`].value) });
        try { const r2 = await api('POST', '/api/admin/tiers', { or: v('or'), platine: v('platine') }); toast(r2.message); paintTiers(); } catch (err) { toast(err.message); }
      };
    };
    // ---- services à la personne : déclaration, crédit d'impôt, avance immédiate ----
    const paintSap = async () => {
      const box = document.getElementById('sapBox');
      if (!box) return;
      let d;
      try { d = await api('GET', '/api/admin/sap'); } catch (e) { box.innerHTML = `<h2>Services à la personne et crédit d'impôt</h2><p class="err">${esc(e.message)}</p>`; return; }
      box.innerHTML = `<h2>Services à la personne et crédit d'impôt</h2>
        <p class="small muted">Une fois Proprigo déclaré « services à la personne » (déclaration gratuite sur nova.entreprises.gouv.fr), vos clients particuliers récupèrent 50 % du prix des ménages à domicile et grands nettoyages en crédit d'impôt. Tant que ce n'est pas activé ici, le site n'en parle pas.</p>
        <form id="sapForm" class="row" style="justify-content:flex-start;gap:12px;flex-wrap:wrap;align-items:end">
          <label class="check"><input type="checkbox" name="declared" ${d.declared ? 'checked' : ''}> Proprigo est déclaré services à la personne</label>
          <label>Numéro de déclaration<input name="numero" value="${esc(d.numero || '')}" placeholder="SAP123456789" maxlength="20"></label>
          <button class="btn blue">Enregistrer</button></form>
        <p class="small" style="margin-top:10px">${d.active ? `<span class="pill ok">Activé</span> Prix « après crédit d'impôt » affichés, mention sur les factures, attestation annuelle officielle.` : '<span class="pill">Non activé</span>'}</p>
        <h3>Avance immédiate (le client ne paie que 50 %)</h3>
        <p class="small muted">Avec l'avance immédiate de l'URSSAF, le crédit d'impôt est déduit au moment du paiement. Il faut d'abord la déclaration SAP, puis une habilitation « tiers de prestation » auprès de l'URSSAF et ses identifiants d'accès à l'API. Dès que vous les avez, le raccordement peut être fait.</p>
        <p class="small"><b>${d.interested}</b> client(s) ont demandé à être prévenus quand ce sera disponible.</p>`;
      document.getElementById('sapForm').onsubmit = async (e) => {
        e.preventDefault();
        try { const r2 = await api('POST', '/api/admin/sap', { declared: e.target.declared.checked, numero: e.target.numero.value }); toast(r2.message); CONFIG.loaded = false; paintSap(); } catch (err) { toast(err.message); }
      };
    };
    // ---- relances des clients inactifs ----
    const paintNudges = async () => {
      const box = document.getElementById('nudgeBox');
      if (!box) return;
      let d;
      try { d = await api('GET', '/api/admin/nudges'); } catch (e) { box.innerHTML = `<h2>Relances des clients</h2><p class="err">${esc(e.message)}</p>`; return; }
      box.innerHTML = `<h2>Relances des clients</h2>
        <p class="small muted">Un e-mail « On repasse faire briller chez vous ? » avec un bouton pour réserver le même ménage, envoyé une fois par jour aux clients sans ménage depuis le délai choisi, et sans réservation à venir. Au plus une relance tous les 120 jours par client ; désinscription en un clic dans chaque e-mail.</p>
        <form id="nudgeForm" class="row" style="justify-content:flex-start;gap:12px;flex-wrap:wrap;align-items:end">
          <label class="check"><input type="checkbox" name="enabled" ${d.settings.enabled ? 'checked' : ''}> Relances automatiques</label>
          <label>Après<select name="days">${[30, 45, 60, 90].map((n) => `<option value="${n}" ${d.settings.days === n ? 'selected' : ''}>${n} jours sans ménage</option>`).join('')}</select></label>
          <button class="btn blue">Enregistrer</button><button type="button" class="btn ghost" id="nudgeRun" ${d.preview.length ? '' : 'disabled'}>Relancer maintenant (${d.preview.length})</button></form>
        <p class="small" style="margin-top:10px">${d.preview.length ? `À relancer aujourd'hui : ${d.preview.slice(0, 8).map((c) => `${esc(c.name)} (dernier ménage le ${dateFr(c.last)})`).join(', ')}${d.preview.length > 8 ? '…' : ''}` : 'Personne à relancer aujourd\'hui.'}</p>
        <p class="small muted">${d.sent30} relance(s) ces 30 derniers jours · ${d.optouts} client(s) désinscrit(s).</p>`;
      const f = document.getElementById('nudgeForm');
      f.onsubmit = async (e) => { e.preventDefault(); try { const r2 = await api('POST', '/api/admin/nudges', { enabled: f.enabled.checked, days: Number(f.days.value) }); toast(r2.message); paintNudges(); } catch (err) { toast(err.message); } };
      document.getElementById('nudgeRun').onclick = async () => {
        if (!confirm(`Envoyer ${d.preview.length} relance(s) maintenant ?`)) return;
        try { const r2 = await api('POST', '/api/admin/nudges/run', {}); toast(r2.message); paintNudges(); } catch (err) { toast(err.message); }
      };
    };
    // ---- tarifs et zones ----
    const paintPricing = async () => {
      const box = document.getElementById('priceBox');
      if (!box) return;
      let d;
      try { d = await api('GET', '/api/admin/pricing'); } catch (e) { box.innerHTML = `<h2>Tarifs et zones</h2><p class="err">${esc(e.message)}</p>`; return; }
      const fill = (st) => {
        const num = (name, v, step = '1', min = '0', max = '1000') => `<input type="number" name="${name}" value="${v}" step="${step}" min="${min}" max="${max}" required>`;
        const zone = (z, title) => `<fieldset class="price-zone"><legend>${title}</legend>
          <label>Ménage à domicile (€ TTC / h)${num(`${z}.menage`, st.grid[z].menage, '0.5')}</label>
          <label>Grand nettoyage (€ TTC / h)${num(`${z}.grand`, st.grid[z].grand, '0.5')}</label>
          <label>Bureaux (€ TTC / h) <span class="muted small" data-ht="${z}"></span>${num(`${z}.bureau`, st.grid[z].bureau, '0.5')}</label>
          ${['studio', 'T2', 'T3', 'maison'].map((k) => `<label>Airbnb ${k === 'T2' ? '2 pièces' : k === 'T3' ? '3 pièces' : k === 'studio' ? 'studio' : 'maison'} (€ le forfait)${num(`${z}.airbnb.${k}`, st.grid[z].airbnb[k], '1')}</label>`).join('')}</fieldset>`;
        const others = st.openDepts.filter((x) => !d.idfDepts.includes(x));
        box.innerHTML = `<h2>Tarifs et zones</h2>
          <p class="small muted">Les nouvelles réservations suivent la nouvelle grille dès l'enregistrement. Les réservations déjà créées gardent leur prix. Un prix qui ne couvre pas le coût d'une heure (${eur(d.cost.heure)} HT) est refusé.</p>
          <form id="priceForm" class="stack">
            <div class="grid2">${zone('IDF', 'Île-de-France')}${zone('FR', 'Hors Île-de-France')}</div>
            <fieldset class="price-zone"><legend>Suppléments et remises</legend><div class="grid2">
              <label>Dimanche et jours fériés (%)${num('sunday', Math.round(st.sunday * 100), '1', '0', '100')}</label>
              <label>Urgence, arrivée dans les 3 h (%)${num('urgent', Math.round(st.urgent * 100), '1', '0', '100')}</label>
              <label>Remise abonnement (%)${num('subscription', Math.round(st.subscription * 100), '1', '0', '30')}</label>
              <label>Matériel et produits fournis (€)${num('kit', st.kit, '0.5', '0', '100')}</label></div></fieldset>
            <fieldset class="price-zone"><legend>Départements ouverts à la réservation</legend>
              <div class="chips">${d.idfDepts.map((x) => `<label class="check chip-check"><input type="checkbox" name="dept" value="${x}" ${st.openDepts.includes(x) ? 'checked' : ''}> ${x}</label>`).join('')}</div>
              <label>Autres départements, prix « hors Île-de-France » (séparés par des virgules)<input name="otherDepts" value="${esc(others.join(', '))}" placeholder="ex. 69, 13"></label>
              <p class="small muted">Ailleurs, les visiteurs peuvent s'inscrire sur la liste d'attente (voir Chiffres › Liste d'attente). Ouvrez un département seulement si des intervenantes y travaillent.</p></fieldset>
            <p class="err" id="priceErr"></p>
            <div class="row" style="justify-content:flex-start;gap:10px;flex-wrap:wrap"><button class="btn blue">Enregistrer les tarifs</button><button type="button" class="btn ghost" id="priceDefaults">Revenir aux prix d'origine</button></div>
          </form>
          ${d.history.length ? `<h3>Derniers changements</h3><ul class="plain small">${d.history.map((h) => `<li><span>${new Date(h.at.replace(' ', 'T') + 'Z').toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · ${esc(h.by_name || '')}<br><span class="muted">${h.changes.map(esc).join(' · ')}</span></span></li>`).join('')}</ul>` : ''}`;
        const f = document.getElementById('priceForm');
        const showHT = () => ['IDF', 'FR'].forEach((z) => { const el = box.querySelector(`[data-ht="${z}"]`); const v = Number(f.elements[`${z}.bureau`].value); if (el) el.textContent = v ? `soit ${eur(Math.round((v / (1 + d.cost.tvaPro)) * 100) / 100)} HT` : ''; });
        showHT();
        f.elements['IDF.bureau'].oninput = showHT; f.elements['FR.bureau'].oninput = showHT;
        document.getElementById('priceDefaults').onclick = () => { fill(d.defaults); toast('Prix d\'origine remis dans le formulaire : enregistrez pour les appliquer.'); };
        f.onsubmit = async (e) => {
          e.preventDefault();
          const v = (n) => Number(f.elements[n].value);
          const grid = (z) => ({ menage: v(`${z}.menage`), grand: v(`${z}.grand`), bureau: v(`${z}.bureau`), airbnb: { studio: v(`${z}.airbnb.studio`), T2: v(`${z}.airbnb.T2`), T3: v(`${z}.airbnb.T3`), maison: v(`${z}.airbnb.maison`) } });
          const depts = [...f.querySelectorAll('[name="dept"]:checked')].map((x) => x.value).concat(f.otherDepts.value.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean));
          const err = document.getElementById('priceErr'); err.textContent = '';
          try {
            const r2 = await api('POST', '/api/admin/pricing', { grid: { IDF: grid('IDF'), FR: grid('FR') }, sunday: v('sunday') / 100, urgent: v('urgent') / 100, subscription: v('subscription') / 100, kit: v('kit'), openDepts: depts });
            toast(r2.message);
            CONFIG.loaded = false;
            paintPricing();
          } catch (e2) { err.textContent = e2.message; }
        };
      };
      fill(d.current);
    };
    if (owner && !document.getElementById('payBox')) {
      $app.insertAdjacentHTML('beforeend', `
        <section class="card" data-tab="chiffres" id="statsBox"><h2>Statistiques par mois</h2><p class="muted small">Chargement…</p></section>
        <section class="card" data-tab="suivi" id="revBox"><h2>Avis des clients</h2><p class="muted small">Chargement…</p></section>
        <section class="card" data-tab="suivi" id="nudgeBox"><h2>Relances des clients</h2><p class="muted small">Chargement…</p></section>
        <section class="card" data-tab="paiements" id="payBox"><h2>Paiements et remboursements</h2><p class="muted small">Chargement…</p></section>
        <section class="card" data-tab="tarifs" id="priceBox"><h2>Tarifs et zones</h2><p class="muted small">Chargement…</p></section>
        <section class="card" data-tab="tarifs" id="tierBox"><h2>Niveaux des intervenantes</h2><p class="muted small">Chargement…</p></section>
        <section class="card" data-tab="tarifs" id="sapBox"><h2>Services à la personne et crédit d'impôt</h2><p class="muted small">Chargement…</p></section>`);
    }
    const showTab = (k) => {
      sessionStorage.setItem('adminTab', k);
      if (k === 'chiffres' && owner) paintStats();
      if (k === 'paiements' && owner) paintPayments();
      if (k === 'tarifs' && owner) { paintPricing(); paintSap(); paintTiers(); }
      if (k === 'suivi' && owner) { paintReviews(); paintNudges(); }
      $app.querySelectorAll('[data-tab]').forEach((el) => { el.hidden = el.dataset.tab !== k; });
      $app.querySelectorAll('[data-tab-btn]').forEach((t) => t.setAttribute('aria-selected', t.dataset.tabBtn === k));
      if (k === 'planning') loadPlanning(planStart);
    };
    // ---- planning de la semaine : une ligne par intervenante, glisser un ménage pour l'attribuer ----
    let planStart = sessionStorage.getItem('planStart') || todayParis();
    const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    async function loadPlanning(start) {
      planStart = start;
      sessionStorage.setItem('planStart', start);
      const box = document.getElementById('plan');
      let p;
      try { p = await api('GET', `/api/admin/planning?start=${start}`); } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
      const days = Array.from({ length: 7 }, (_, i) => addDays(p.start, i));
      const chip = (b, movable) => `<button type="button" class="pchip st-${b.status}" data-bk="${b.id}" ${movable ? 'draggable="true"' : ''} title="Réservation n° ${b.id}">
          <b>${esc(b.time)}</b> ${esc(b.label)}<span>${esc(b.cp)}${b.paid ? '' : ' · à payer'}</span></button>`;
      const movable = (b) => ['en_attente', 'proposee', 'attribuee'].includes(b.status);
      const cell = (wid, d) => {
        const list = p.bookings.filter((b) => b.date === d && (wid ? b.worker_id === wid : !b.worker_id));
        return `<td class="pcell" data-worker="${wid || ''}" data-day="${d}">${list.map((b) => chip(b, movable(b))).join('')}</td>`;
      };
      const unassigned = p.bookings.filter((b) => !b.worker_id).length;
      box.innerHTML = `
        <div class="plan-head">
          <h2>Semaine du ${dateFr(p.start)}</h2>
          <div class="row" style="gap:6px;flex-wrap:nowrap">
            <button class="btn ghost" data-week="-7" aria-label="Semaine précédente">‹</button>
            <button class="btn ghost" data-week="0">Aujourd'hui</button>
            <button class="btn ghost" data-week="7" aria-label="Semaine suivante">›</button>
          </div>
        </div>
        <p class="small muted">${unassigned ? `${unassigned} ménage${unassigned > 1 ? 's' : ''} à attribuer. ` : ''}Faites glisser un ménage sur la ligne d'une intervenante, ou touchez-le pour choisir dans la liste.</p>
        <div class="plan-scroll"><table class="plan">
          <thead><tr><th></th>${days.map((d) => `<th class="${d === todayParis() ? 'today' : ''}">${dateFr(d)}</th>`).join('')}</tr></thead>
          <tbody>
            <tr class="unassigned"><th>À attribuer</th>${days.map((d) => cell(null, d)).join('')}</tr>
            ${p.workers.map((w) => `<tr class="${w.absent ? 'absent' : ''}"><th>${esc(w.name)}<span>${w.statut === 'S' ? 'Salariée' : 'Indépendante'}${w.absent ? ' · absente' : ''}</span></th>${days.map((d) => cell(w.user_id, d)).join('')}</tr>`).join('') || '<tr><td colspan="8" class="muted">Aucune intervenante active.</td></tr>'}
          </tbody></table></div>`;
      box.querySelectorAll('[data-week]').forEach((b) => b.onclick = () => loadPlanning(b.dataset.week === '0' ? todayParis() : addDays(planStart, Number(b.dataset.week))));
      box.querySelectorAll('.pchip').forEach((c) => {
        c.onclick = () => {
          box.querySelectorAll('.pchip.sel').forEach((x) => x.classList.remove('sel'));
          c.classList.add('sel');
          const host = document.getElementById('planPick');
          showPicker(c.dataset.bk, host);
          host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        };
        c.ondragstart = (e) => {
          e.dataTransfer.setData('text/plain', c.dataset.bk); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging');
          // Pendant le glisser : les intervenantes libres à ce créneau s'allument, les autres se grisent.
          const b = p.bookings.find((x) => String(x.id) === c.dataset.bk);
          api('GET', `/api/admin/bookings/${c.dataset.bk}/candidates`).then((cand) => {
            if (!c.classList.contains('dragging')) return;
            const ok = new Set(cand.list.filter((w) => !w.refused).map((w) => String(w.user_id)));
            box.querySelectorAll(`.pcell[data-day="${b.date}"][data-worker]:not([data-worker=""])`).forEach((td) => td.classList.add(ok.has(td.dataset.worker) ? 'can' : 'cannot'));
          }).catch(() => {});
        };
        c.ondragend = () => { c.classList.remove('dragging'); box.querySelectorAll('.pcell.can, .pcell.cannot').forEach((td) => td.classList.remove('can', 'cannot')); };
      });
      box.querySelectorAll('.pcell[data-worker]:not([data-worker=""])').forEach((td) => {
        td.ondragover = (e) => { e.preventDefault(); td.classList.add('over'); };
        td.ondragleave = () => td.classList.remove('over');
        td.ondrop = async (e) => {
          e.preventDefault();
          td.classList.remove('over');
          const id = e.dataTransfer.getData('text/plain');
          const b = p.bookings.find((x) => String(x.id) === id);
          if (!b) return;
          if (b.date !== td.dataset.day) { toast('Pour changer de jour, modifiez la réservation. Ici, on change seulement d\'intervenante.'); return; }
          try { const r = await api('POST', `/api/admin/bookings/${id}/assign`, { worker_id: td.dataset.worker }); toast(r.message || 'Intervenante attribuée.'); loadPlanning(planStart); }
          catch (err) { toast(err.message); }
        };
      });
    }
    $app.querySelectorAll('[data-tab-btn]').forEach((t) => t.onclick = () => { showTab(t.dataset.tabBtn); window.scrollTo(0, 0); });
    showTab((params && params.get('tab')) || sessionStorage.getItem('adminTab') || 'todo');
    const paintJournal = () => {
      const type = document.getElementById('jType').value;
      const bk = document.getElementById('jBk').value.trim();
      const re = bk ? new RegExp(`n° ${bk.replace(/\D/g, '')}\\b`) : null;
      const list = r.events.filter((e) => (!type || eventType(e.text) === type) && (!re || re.test(e.text)));
      document.getElementById('jList').innerHTML = list.slice(0, 40).map((e) => `<li><span class="small muted">${new Date(e.at.replace(' ', 'T') + 'Z').toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' })}</span><br>${esc(e.text)}</li>`).join('') || '<li class="muted">Aucun événement.</li>';
      document.getElementById('jMore').textContent = list.length > 40 ? `${list.length - 40} événements plus anciens non affichés : précisez le filtre.` : '';
    };
    document.getElementById('jType').onchange = paintJournal;
    document.getElementById('jBk').oninput = paintJournal;
    paintJournal();
    bind('data-ikeep', (id) => `/api/admin/bookings/${id}/ical-keep`);
    const db1 = document.getElementById('doBackup');
    if (db1) db1.onclick = async () => { db1.disabled = true; try { const r = await api('POST', '/api/admin/backups', {}); toast(r.message); route(); } catch (e) { toast(e.message); db1.disabled = false; } };
    bind('data-icancel', (id) => `/api/admin/bookings/${id}/cancel`);
    $app.querySelectorAll('[data-goto]').forEach((b) => b.onclick = () => { showTab({ incidents: 'todo', table: 'resa', team: 'equipe' }[b.dataset.goto]); document.getElementById(`sec-${b.dataset.goto}`).scrollIntoView({ behavior: 'smooth' }); });

    $app.querySelectorAll('[data-inc]').forEach((btn) => btn.onclick = () => {
      const box = document.getElementById(`thread-inc-${btn.dataset.thread}`);
      if (box.innerHTML) { box.innerHTML = ''; return; }
      openThread(box, btn.dataset.thread).catch((e) => toast(e.message));
    });
    $app.querySelectorAll('[data-thread]:not([data-inc])').forEach((btn) => btn.onclick = () => {
      const box = document.getElementById(`thread-${btn.dataset.thread}`);
      if (box.innerHTML) { box.innerHTML = ''; return; }
      openThread(box, btn.dataset.thread).catch((e) => toast(e.message));
    });
    $app.querySelectorAll('[data-noshow]').forEach((b) => b.onclick = async () => {
      const note = prompt("Absence non prévenue de l'intervenante : la mission repart à attribuer et l'absence compte pour son niveau (pas de Platine pendant 6 mois).\n\nNote interne (facultatif) :", '');
      if (note === null) return;
      try { const r2 = await api('POST', `/api/admin/bookings/${b.dataset.noshow}/no-show`, { note }); toast(r2.message); route(); } catch (e) { toast(e.message); }
    });
    // Liste de choix directe : intervenantes libres, de la plus proche à la plus éloignée.
    async function showPicker(id, host) {
      let c;
      try { c = await api('GET', `/api/admin/bookings/${id}/candidates`); } catch (e) { return toast(e.message); }
      const opts = c.list.map((w) => `<option value="${w.user_id}">${esc(w.name)} · ${w.statut === 'S' ? 'salariée' : 'indépendante'} · ${esc(w.cp)} · ${esc(w.proximite)}${w.offered ? ' · déjà proposée' : ''}${w.refused ? ' · a refusé' : ''}</option>`).join('');
      host.innerHTML = `<div class="pick">
        <label>Intervenantes libres à cette heure-là, de la plus proche à la plus éloignée
          <select id="pick-${id}">${opts}<option value="auto">Choix automatique</option></select></label>
        ${c.list.length ? '' : '<p class="small muted">Aucune autre intervenante n\'est libre à cette heure-là.</p>'}
        <p class="small muted">La prestation doit être payée avant attribution. Une salariée reçoit la mission directement. Une indépendante la reçoit en proposition et peut refuser.</p>
        <div class="row" style="justify-content:flex-start"><button class="btn blue" id="ok-${id}">Valider</button><button class="btn ghost" id="no-${id}">Annuler</button></div>
      </div>`;
      document.getElementById(`no-${id}`).onclick = () => { host.innerHTML = ''; host.closest('.pickrow')?.remove(); };
      document.getElementById(`ok-${id}`).onclick = async (e) => {
        e.target.disabled = true;
        try {
          const r = await api('POST', `/api/admin/bookings/${id}/assign`, { worker_id: document.getElementById(`pick-${id}`).value });
          toast(r.message || 'C\'est enregistré.');
          route();
        } catch (err) { toast(err.message); e.target.disabled = false; }
      };
    }
    $app.querySelectorAll('[data-pick]').forEach((btn) => btn.onclick = () => {
      const tr = btn.closest('tr');
      const open = tr.nextElementSibling && tr.nextElementSibling.classList.contains('pickrow');
      $app.querySelectorAll('.pickrow').forEach((x) => x.remove());
      if (open) return;
      const row = document.createElement('tr');
      row.className = 'pickrow';
      row.innerHTML = '<td colspan="9"></td>';
      tr.after(row);
      showPicker(btn.dataset.pick, row.firstChild);
    });
    $app.querySelectorAll('[data-goto-bk]').forEach((b) => b.onclick = () => {
      const host = document.getElementById(`todo-pick-${b.dataset.gotoBk}`);
      if (host.innerHTML) { host.innerHTML = ''; return; }
      showPicker(b.dataset.gotoBk, host);
    });
  };

  // ---------- espace entreprises : bureaux, agences, syndics, conciergeries ----------
  // ---- formulaire de devis réutilisable (entreprises, syndics, agences) ----
  const devisBlock = (kind, title = 'Demander un devis') => `<section class="card stack" id="devis">
        <h2>${title}</h2>
        <p class="small muted">Réponse sous 24 h ouvrées, avec un prix ferme après une courte visite si nécessaire.</p>
        <form id="devisForm" class="grid2" style="gap:12px">
          <label>${kind === 'syndic' ? 'Syndic ou copropriété' : kind === 'agence' ? 'Agence' : 'Société'}<input name="company" required maxlength="120" autocomplete="organization"></label>
          <label>Votre nom<input name="name" required maxlength="80" autocomplete="name"></label>
          <label>E-mail professionnel<input type="email" name="email" required maxlength="120" autocomplete="email"></label>
          <label>Téléphone<input type="tel" name="phone" maxlength="20" autocomplete="tel"></label>
          <label>Code postal ${kind === 'syndic' ? 'de l\'immeuble' : 'des logements'}<input name="cp" inputmode="numeric" maxlength="5" required></label>
          <input type="hidden" name="kind" value="${kind}">
          <label>${kind === 'syndic' ? 'Surface des parties communes (m², environ)' : 'Nombre de logements par mois (environ)'}<input type="number" name="surface" min="0" max="100000"></label>
          <label style="grid-column:1/-1">Fréquence souhaitée<input name="frequency" maxlength="60" placeholder="${kind === 'syndic' ? 'Ex. 2 passages par semaine' : 'Ex. 4 fins de bail par mois'}"></label>
          <label style="grid-column:1/-1">Précisions (facultatif)<textarea name="message" rows="3" maxlength="1000" placeholder="${kind === 'syndic' ? 'Nombre d\'étages, ascenseur, vitres, local poubelles…' : 'Surfaces habituelles, remise des clés, délais avant état des lieux…'}"></textarea></label>
          <button class="btn primary" style="grid-column:1/-1">Envoyer ma demande</button>
        </form>
        <p class="msg" id="devisDone"></p>
      </section>`;
  const bindDevis = () => {
    const f = document.getElementById('devisForm');
    if (!f) return;
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api('POST', '/api/quote-requests', formData(e.target)); const d = document.getElementById('devisDone'); d.className = 'msg ok'; d.textContent = r.message; e.target.hidden = true; } catch (err) { toast(err.message); }
    };
    document.querySelectorAll('[data-todevis]').forEach((a) => a.onclick = (e) => { e.preventDefault(); document.getElementById('devis').scrollIntoView({ behavior: 'smooth' }); });
  };

  // ---- syndics de copropriété ----
  views['syndics'] = () => {
    const P = PRICES();
    $app.innerHTML = `
      <section class="hello pro-hello">
        <div class="hello-text">
          <p class="hello-hi">Syndics et copropriétés</p>
          <h1>Des parties communes nettes, sans relancer personne</h1>
          <p class="hello-sub">Hall, escaliers, paliers, ascenseur, vitres des parties communes : un passage régulier à la fréquence convenue, la même intervenante, et la preuve de chaque passage.</p>
          <a class="btn primary" href="#devis" data-todevis>Demander un devis</a>
        </div>
        <div class="hello-art" aria-hidden="true">${ART.services.grand}</div>
      </section>
      <div class="pro-grid">
        <article class="card"><h3>Ce qui est fait</h3><ul class="ticks"><li>Hall d'entrée, boîtes aux lettres, portes vitrées</li><li>Escaliers, paliers, rampes</li><li>Cabine d'ascenseur</li><li>Vitres des parties communes accessibles</li><li>Liste de tâches propre à votre immeuble</li></ul></article>
        <article class="card"><h3>Comment ça se passe</h3><ul class="ticks"><li>Fréquence fixée ensemble (chaque semaine, plusieurs fois par semaine…)</li><li>Une intervenante attitrée, remplacée si elle est absente</li><li>Tâches cochées et photos après passage, consultables en ligne</li><li>Un signalement en un clic si quelque chose ne va pas</li></ul></article>
        <article class="card"><h3>Facturation</h3><ul class="ticks"><li>À partir de ${String(CONFIG.franchiseTVA ? P.bureau : P.bureauHT).replace('.', ',')} € ${CONFIG.franchiseTVA ? '' : 'HT '}de l'heure</li><li>Une facture par passage, au nom du syndic, téléchargeable</li><li>Paiement en ligne sécurisé</li><li>Sans engagement de durée</li></ul></article>
      </div>
      ${devisBlock('syndic', 'Devis pour votre immeuble')}`;
    bindDevis();
  };

  // ---- agences immobilières et gestionnaires ----
  views['agences'] = () => {
    const P = PRICES();
    $app.innerHTML = `
      <section class="hello pro-hello">
        <div class="hello-text">
          <p class="hello-hi">Agences immobilières et gestionnaires</p>
          <h1>Des logements prêts pour l'état des lieux</h1>
          <p class="hello-sub">Fins de bail, remises en état entre deux locataires, logements vides avant une visite : vous indiquez l'adresse et la date, on s'occupe du reste. Photos après le passage à joindre au dossier.</p>
          <a class="btn primary" href="#devis" data-todevis>Demander un devis</a>
        </div>
        <div class="hello-art" aria-hidden="true">${ART.services.menage}</div>
      </section>
      <div class="pro-grid">
        <article class="card"><h3>Fin de bail et relocation</h3><ul class="ticks"><li>Cuisine et électroménager, salle de bain, sols, vitres</li><li>Placards et rangements vidés nettoyés</li><li>Liste de tâches adaptée à chaque logement</li><li>Photos après le passage, pour l'état des lieux</li></ul></article>
        <article class="card"><h3>Pensé pour plusieurs logements</h3><ul class="ticks"><li>Un seul compte pour toutes vos adresses (« Mes logements »)</li><li>Consignes d'accès et remise des clés notées une fois</li><li>Suivi en direct : en route, arrivée, terminé</li><li>Une facture par logement, au nom de l'agence</li></ul></article>
        <article class="card"><h3>Prix</h3><ul class="ticks"><li>Grand nettoyage : ${String(P.grand).replace('.', ',')} € TTC de l'heure</li><li>Durée estimée avant de réserver, prix connu à l'avance</li><li>Pour un volume régulier, devis personnalisé</li><li>Annulation gratuite jusqu'à 24 h avant</li></ul></article>
      </div>
      ${devisBlock('agence', 'Devis pour vos logements')}`;
    bindDevis();
  };

  // ---- recrutement des intervenantes ----
  views['recrutement'] = async () => {
    let info = { docs: { S: [], I: [] }, rate: { min: 15, max: 40 } };
    try { info = await api('GET', '/api/recruitment'); } catch { /* liste par défaut */ }
    const docs = (list) => list.map((d) => `<li>${esc(d.label)}${d.required ? '' : ' <span class="muted">(facultatif)</span>'}</li>`).join('');
    $app.innerHTML = `
      <section class="hello">
        <div class="hello-text">
          <p class="hello-hi">Rejoindre Proprigo</p>
          <h1>Faites briller Paris, à votre rythme</h1>
          <p class="hello-sub">Des ménages près de chez vous, des consignes claires, une application sur votre téléphone et une équipe joignable pendant chaque mission. Femmes et hommes, tous les profils sont les bienvenus.</p>
          <a class="btn primary" href="#/inscription-intervenante">Je postule</a>
        </div>
        <div class="hello-art" aria-hidden="true">${ART.services.menage}</div>
      </section>
      <div class="pro-grid">
        <article class="card"><h3>Indépendante (micro-entreprise)</h3><ul class="ticks">
          <li>Vous choisissez vos missions et pouvez refuser sans pénalité</li>
          <li>Votre tarif horaire, entre ${info.rate.min} et ${info.rate.max} €, fixé avec nous</li>
          <li>Virement chaque semaine pour les ménages terminés</li>
          <li>Niveaux 🔵 Bleu, 🥇 Or (priorité sur les missions) et 💎 Platine (+1 € de l'heure)</li></ul></article>
        <article class="card"><h3>Salariée</h3><ul class="ticks">
          <li>Proprigo vous emploie</li>
          <li>Missions planifiées selon vos disponibilités</li>
          <li>Formation et première mission accompagnée</li>
          <li>Heures déclarées sur votre fiche de paie</li></ul></article>
        <article class="card"><h3>Pour toutes</h3><ul class="ticks">
          <li>Missions proches de chez vous</li>
          <li>Notifications des nouvelles missions sur votre téléphone</li>
          <li>Votre semaine en un coup d'œil, vos congés gérés en ligne</li>
          <li>Un bouton pour prévenir l'équipe en cas de problème sur place</li></ul></article>
      </div>
      <section class="card">
        <h2>Comment ça se passe</h2>
        <ol class="steps-list">
          <li><b>Inscription en ligne</b> : cinq minutes, sur ordinateur ou téléphone.</li>
          <li><b>Confirmation de votre adresse e-mail</b> avec le lien reçu.</li>
          <li><b>Vos documents</b>, en photo ou en PDF, depuis votre espace.</li>
          <li><b>Un entretien</b> avec l'équipe.</li>
          <li><b>Vos premières missions</b>, dès que votre dossier est validé.</li>
        </ol>
      </section>
      <section class="card">
        <h2>Documents demandés</h2>
        <div class="grid2"><div><h3>Indépendante</h3><ul class="ticks">${docs(info.docs.I)}</ul></div><div><h3>Salariée</h3><ul class="ticks">${docs(info.docs.S)}</ul></div></div>
      </section>
      <section class="faq-home">
        <h2>Questions fréquentes</h2>
        <details class="faq"><summary>Combien vais-je gagner ?</summary><p>En indépendante : votre tarif horaire multiplié par les heures de ménage, avant vos cotisations. Par exemple, 3 h à 22 € de l'heure font 66 €. Vos gains s'affichent mois par mois dans votre espace.</p></details>
        <details class="faq"><summary>Puis-je refuser une mission ?</summary><p>En indépendante, oui, sans pénalité : vous recevez des propositions et vous acceptez celles qui vous conviennent. En salariée, vos missions suivent les disponibilités que vous indiquez.</p></details>
        <details class="faq"><summary>Que se passe-t-il si j'ai un problème chez un client ?</summary><p>Un bouton dans la mission prévient l'équipe immédiatement : accès impossible, objet abîmé, logement bien plus sale que prévu, ou si vous ne vous sentez pas en sécurité.</p></details>
        <details class="faq"><summary>Faut-il du matériel ?</summary><p>Le client fournit en général aspirateur et produits. Il peut choisir l'option « matériel apporté » : c'est indiqué dans la mission.</p></details>
      </section>
      <section class="final"><h2>Prête à commencer ?</h2><a class="btn primary" href="#/inscription-intervenante">Je postule</a></section>`;
  };

  views['pro'] = () => {
    $app.innerHTML = `
      <section class="hello pro-hello">
        <div class="hello-text">
          <p class="hello-hi">Entreprises</p>
          <h1>Le ménage de vos locaux, sans y penser</h1>
          <p class="hello-sub">Bureaux, fins de bail, parties communes, logements de location courte durée : une intervenante régulière, une facture au nom de votre société, des tarifs qui baissent avec le volume.</p>
          <a class="btn primary" href="#devis" id="toDevis">Demander un devis</a>
        </div>
        <div class="hello-art" aria-hidden="true">${ART.services.bureau}</div>
      </section>
      <div class="pro-grid">
        <article class="card"><span class="offer-art">${ART.services.bureau}</span><h3>Bureaux</h3><p>Avant l'ouverture ou après la fermeture, de 6 h à 22 h. Postes de travail, sanitaires, coin café, salles de réunion.</p><p class="offer-price"><b>35 €</b> HT de l'heure</p></article>
        <article class="card"><span class="offer-art">${ART.services.grand}</span><h3>Agences et syndics</h3><p class="small"><a href="#/syndics">Syndics de copropriété</a> · <a href="#/agences">Agences immobilières</a></p><p>Fins de bail prêtes pour l'état des lieux, remises en état avant relocation, entretien des parties communes.</p><p class="offer-price"><b>Sur devis</b></p></article>
        <article class="card"><span class="offer-art">${ART.services.airbnb}</span><h3>Conciergeries</h3><p>Ménage et linge après chaque départ, calendriers synchronisés, la même intervenante par logement, photos avant / après.</p><p class="offer-price"><b>dès ${String(PRICES().airbnb.studio).replace('.', ',')} €</b> le logement</p></article>
      </div>
      <section class="card">
        <h2>Plus vous commandez, moins vous payez</h2>
        <p class="small muted">Avec un compte société, sur le nettoyage de bureaux et les logements Airbnb, selon le nombre de prestations du mois.</p>
        <div class="gain-grid"><div class="gain"><span>Jusqu'à 9 prestations</span><b>Tarif normal</b></div><div class="gain"><span>10 à 29 prestations</span><b>−5 %</b></div><div class="gain main"><span>30 prestations et plus</span><b>−10 %</b></div></div>
        <p class="small muted" style="margin:10px 0 0">La remise s'applique toute seule. Elle ne se cumule pas avec la remise d'abonnement : la plus avantageuse est retenue.</p>
      </section>
      <section class="card stack" id="devis">
        <h2>Demander un devis</h2>
        <form id="devisForm" class="grid2" style="gap:12px">
          <label>Société<input name="company" required maxlength="120" autocomplete="organization"></label>
          <label>Votre nom<input name="name" required maxlength="80" autocomplete="name"></label>
          <label>E-mail professionnel<input type="email" name="email" required maxlength="120" autocomplete="email"></label>
          <label>Téléphone<input type="tel" name="phone" maxlength="20" autocomplete="tel"></label>
          <label>Code postal des locaux<input name="cp" inputmode="numeric" maxlength="5" required></label>
          <label>Type de besoin<select name="kind" required>${[['bureaux', 'Bureaux'], ['agence', 'Agence immobilière / fins de bail'], ['syndic', 'Syndic / parties communes'], ['conciergerie', 'Conciergerie / logements Airbnb'], ['autre', 'Autre']].map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>
          <label>Surface approximative (m²)<input type="number" name="surface" min="0" max="100000"></label>
          <label>Fréquence souhaitée<input name="frequency" maxlength="60" placeholder="Ex. 3 fois par semaine, 4 fins de bail par mois"></label>
          <label style="grid-column:1/-1">Précisions (facultatif)<textarea name="message" rows="3" maxlength="1000"></textarea></label>
          <button class="btn primary" style="grid-column:1/-1">Envoyer ma demande</button>
        </form>
        <p class="msg" id="devisDone"></p>
      </section>`;
    document.getElementById('toDevis').onclick = (e) => { e.preventDefault(); document.getElementById('devis').scrollIntoView({ behavior: 'smooth' }); };
    document.getElementById('devisForm').onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api('POST', '/api/quote-requests', formData(e.target)); const d = document.getElementById('devisDone'); d.className = 'msg ok'; d.textContent = r.message; e.target.hidden = true; } catch (err) { toast(err.message); }
    };
  };

  // ---------- offrir un ménage : cartes cadeaux et packs d'heures ----------
  views['cadeau'] = async () => {
    const offer = await api('GET', '/api/gifts/offer');
    const back = new URLSearchParams(location.search);
    let amount = 100;
    $app.innerHTML = `
      <section class="hello gift-hello">
        <div class="hello-text">
          <p class="hello-hi">Carte cadeau</p>
          <h1>Offrez un intérieur qui brille</h1>
          <p class="hello-sub">Un cadeau utile pour des parents, de jeunes parents ou des amis qui déménagent. Valable 1 an, sur toutes les prestations.</p>
        </div>
        <div class="hello-art" aria-hidden="true">${ART.services.menage}</div>
      </section>
      ${back.get('stripe') === 'success' ? '<p class="msg ok" style="margin-top:14px">Paiement reçu. La carte cadeau part par e-mail dès que Stripe confirme, en général en quelques secondes.</p>' : ''}
      <div class="gift-grid">
        <section class="card stack">
          <h2>Offrir une carte</h2>
          <div class="chips" role="group" aria-label="Montant">${offer.amounts.map((a) => `<button type="button" data-amount="${a}" aria-pressed="${a === amount}">${a} €</button>`).join('')}</div>
          <p class="small muted" style="margin:0" id="amountHint"></p>
          <form id="giftForm" class="stack">
            <label>Prénom de la personne<input name="recipient_name" maxlength="60" placeholder="Ex. Maman"></label>
            <label>Son e-mail (facultatif : sinon, vous recevez le code pour le lui donner)<input type="email" name="recipient_email" maxlength="120"></label>
            <label>Un petit mot (facultatif)<textarea name="message" rows="2" maxlength="300" placeholder="Ex. Joyeux Noël, profite de ton dimanche !"></textarea></label>
            <button class="btn primary full" id="giftBtn">Offrir 100 €</button>
          </form>
        </section>
        <section class="card stack">
          <h2>Pour vous : un pack d'heures</h2>
          <p class="small muted" style="margin:0">Payez d'avance, recevez des heures offertes. Le crédit est déduit tout seul de vos prochains ménages.</p>
          ${offer.packs.map((p) => `<div class="pack">
            <div><b>${p.hours} h de ménage</b><span>${p.free} h offerte${p.free > 1 ? 's' : ''} · ${eur(p.credit)} de crédit</span></div>
            <button class="btn blue" data-pack="${p.hours}">${eur(p.price)}</button></div>`).join('')}
          <h2 style="margin-top:10px">Vous avez reçu une carte ?</h2>
          <form id="redeemForm" class="cp-row">
            <label>Code de la carte<input name="code" maxlength="20" autocapitalize="characters" placeholder="PG-XXXX-XXXX" required></label>
            <button class="btn ghost">Utiliser</button>
          </form>
        </section>
      </div>`;
    const hint = () => { document.getElementById('amountHint').textContent = `Environ ${String(Math.round((amount / 37) * 2) / 2).replace('.', ',')} h de ménage à domicile en Île-de-France.`; document.getElementById('giftBtn').textContent = `Offrir ${amount} €`; };
    hint();
    $app.querySelectorAll('[data-amount]').forEach((b) => b.onclick = () => { amount = Number(b.dataset.amount); $app.querySelectorAll('[data-amount]').forEach((x) => x.setAttribute('aria-pressed', x === b)); hint(); });
    const needLogin = () => { if (me && me.role === 'client') return false; sessionStorage.setItem('after', '#/cadeau'); toast('Créez votre compte client pour continuer.'); go('#/inscription'); return true; };
    const pay = async (body, btn) => {
      if (needLogin()) return;
      btn.disabled = true;
      try { const r = await api('POST', '/api/gifts', body); if (r.checkout_url) { window.location.assign(r.checkout_url); return; } toast(r.message); route(); }
      catch (e) { toast(e.message); btn.disabled = false; }
    };
    document.getElementById('giftForm').onsubmit = (e) => { e.preventDefault(); pay({ amount, ...formData(e.target) }, document.getElementById('giftBtn')); };
    $app.querySelectorAll('[data-pack]').forEach((b) => b.onclick = () => pay({ kind: 'pack', hours: Number(b.dataset.pack) }, b));
    document.getElementById('redeemForm').onsubmit = async (e) => {
      e.preventDefault();
      const code = e.target.code.value.trim();
      if (!me || me.role !== 'client') { sessionStorage.setItem('cadeau', code); go('#/inscription'); return; }
      try { const r = await api('POST', '/api/gifts/redeem', { code }); toast(r.message); e.target.reset(); } catch (err) { toast(err.message); }
    };
  };

  // ---------- mot de passe oublié ----------
  views['mot-de-passe-oublie'] = () => {
    $app.innerHTML = `
      <section class="card stack" style="max-width:460px;margin:auto">
        <h1>Mot de passe oublié</h1>
        <p class="muted">Entrez l'e-mail de votre compte. Nous vous envoyons un lien pour choisir un nouveau mot de passe, valable 1 heure.</p>
        <form id="f" class="stack">
          <label>E-mail<input type="email" name="email" autocomplete="email" required></label>
          <button class="btn primary full">Recevoir le lien</button>
        </form>
        <p class="msg" id="done"></p>
        <p class="small"><a href="#/connexion">Retour à la connexion</a></p>
      </section>`;
    document.getElementById('f').onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api('POST', '/api/password/forgot', formData(e.target)); const d = document.getElementById('done'); d.className = 'msg ok'; d.textContent = r.message; e.target.hidden = true; } catch (err) { toast(err.message); }
    };
  };

  // Adresse e-mail pas encore confirmée : bandeau discret avec « Renvoyer le lien ».
  function verifyBanner(name) {
    if (!me || me.role === 'admin' || me.email_verified !== 0 || name === 'confirmer-email') return;
    $app.insertAdjacentHTML('afterbegin', `<div class="msg warn verify-banner" role="status">
      <span>Confirmez votre adresse <b>${esc(me.email)}</b> avec le lien reçu par e-mail : vos confirmations, rappels et factures y arrivent.</span>
      <button class="btn ghost small-btn" id="verifyResend">Renvoyer le lien</button></div>`);
    document.getElementById('verifyResend').onclick = async (e) => {
      e.target.disabled = true;
      try { const r = await api('POST', '/api/email/resend', {}); toast(r.message); } catch (err) { toast(err.message); e.target.disabled = false; }
    };
  }
  views['confirmer-email'] = async (params) => {
    $app.innerHTML = '<section class="card stack" style="max-width:460px;margin:auto"><h1>Confirmation de votre adresse</h1><p class="muted" id="vmsg">Vérification en cours…</p></section>';
    const msg = document.getElementById('vmsg');
    try {
      const r = await api('POST', '/api/email/verify', { token: params.get('t') || '' });
      await loadMe().catch(() => {});
      msg.className = 'msg ok';
      msg.textContent = r.message;
      msg.insertAdjacentHTML('afterend', me ? `<a class="btn primary" href="#/${me.role === 'intervenante' ? 'intervenante' : 'reserver'}">${me.role === 'intervenante' ? 'Mon espace' : 'Réserver un ménage'}</a>` : '<a class="btn primary" href="#/connexion">Se connecter</a>');
    } catch (e) {
      msg.className = 'msg warn';
      msg.textContent = e.message;
    }
  };
  views['nouveau-mot-de-passe'] = (params) => {
    const token = params.get('t') || '';
    $app.innerHTML = `
      <section class="card stack" style="max-width:460px;margin:auto">
        <h1>Nouveau mot de passe</h1>
        <form id="f" class="stack">
          <label>Nouveau mot de passe (10 caractères minimum)<input type="password" name="password" autocomplete="new-password" minlength="10" required></label>
          <label>Confirmez<input type="password" name="again" autocomplete="new-password" minlength="10" required></label>
          <p class="err" id="err"></p>
          <button class="btn primary full">Enregistrer</button>
        </form>
      </section>`;
    document.getElementById('f').onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      const err = document.getElementById('err');
      if (f.password !== f.again) { err.textContent = 'Les deux mots de passe sont différents.'; return; }
      try {
        const r = await api('POST', '/api/password/reset', { token, password: f.password });
        await loadMe();
        toast('Mot de passe changé. Vous êtes connecté.');
        go(r.role === 'admin' ? '#/admin' : r.role === 'intervenante' ? '#/intervenante' : '#/');
      } catch (ex) { err.innerHTML = `${esc(ex.message)} <a href="#/mot-de-passe-oublie">Recevoir un nouveau lien</a>`; }
    };
  };

  // ---------- mon compte ----------
  views['compte'] = async () => {
    if (!me) return go('#/connexion');
    let card = null;
    let ref = null;
    if (me.role === 'intervenante') card = await api('GET', `/api/workers/${me.id}/card`).catch(() => null);
    if (me.role === 'client') ref = await api('GET', '/api/referral').catch(() => null);
    const year = new Date().getFullYear();
    $app.innerHTML = `
      <h1>Mon compte</h1>
      ${ref ? `<section class="hello refer" data-o="4">
        <div class="hello-text">
          <p class="hello-hi">Parrainage</p>
          <h1>Offrez ${ref.amount} €, recevez ${ref.amount} €</h1>
          <p class="hello-sub">Votre proche a ${ref.amount} € de réduction sur son premier ménage. Vous recevez ${ref.amount} € dès qu'il est fait.${ref.credit ? ` <b>Crédit disponible : ${eur(ref.credit)}</b>, déduit de votre prochaine réservation.` : ''}</p>
          <div class="ref-code"><span>Votre code</span><b>${esc(ref.code)}</b></div>
          <div class="actions ref-actions"><button class="btn primary" id="shareRef">Partager mon lien</button><button class="btn ghost light" id="copyRef">Copier le lien</button></div>
          ${ref.friends ? `<p class="hello-sub" style="margin:10px 0 0">${ref.friends} proche${ref.friends > 1 ? 's' : ''} inscrit${ref.friends > 1 ? 's' : ''} avec votre code.</p>` : ''}
        </div>
      </section>
      <details class="card stack" id="companyBox" data-o="6"><summary><b>Société (facultatif)</b> <span class="muted small">facture au nom de votre entreprise, remise selon le volume</span></summary>
        <form id="companyForm" class="grid2" style="gap:12px;margin-top:12px">
          <label>Raison sociale<input name="company" maxlength="120" autocomplete="organization"></label>
          <label>SIRET (14 chiffres)<input name="siret" inputmode="numeric" maxlength="20"></label>
          <label>N° de TVA intracommunautaire<input name="vat_number" maxlength="20" placeholder="FR12345678901"></label>
          <label>Adresse de facturation<input name="billing_address" maxlength="200"></label>
          <p class="small muted" id="volumeInfo" style="grid-column:1/-1;margin:0"></p>
          <button class="btn blue" style="grid-column:1/-1">Enregistrer la société</button>
        </form>
      </details>
      <section class="card stack" data-o="5"><h2>Crédit et cartes cadeaux</h2>
        <p style="margin:0">Crédit disponible : <b id="myCredit">${eur(ref.credit)}</b>, déduit automatiquement de vos prochains ménages.</p>
        <form id="redeem2" class="cp-row"><label>Code d'une carte cadeau<input name="code" maxlength="20" autocapitalize="characters" placeholder="PG-XXXX-XXXX" required></label><button class="btn ghost">Utiliser</button></form>
        <p class="small" style="margin:0"><a href="#/cadeau">Offrir un ménage ou acheter un pack d'heures</a></p>
      </section>
      <section class="card stack" data-o="3"><h2>${sapOn() ? 'Mes documents' : 'Récapitulatif de mes ménages'}</h2>
        <p class="small muted">${sapOn() ? "Les reçus de chaque ménage sont dans « Mes ménages ». L'attestation annuelle récapitule les ménages à domicile pour le crédit d'impôt." : "Les reçus de chaque ménage sont dans « Mes ménages ». Ici, le récapitulatif de l'année, pratique pour vos comptes."}</p>
        <div class="actions" style="margin:0"><a class="btn ghost" href="/api/me/attestation?year=${year}" target="_blank" rel="noopener">${sapOn() ? 'Attestation' : 'Récapitulatif'} ${year}</a><a class="btn ghost" href="/api/me/attestation?year=${year - 1}" target="_blank" rel="noopener">${sapOn() ? 'Attestation' : 'Récapitulatif'} ${year - 1}</a></div>
      </section>` : ''}
      ${me.role === 'client' ? '<section class="card stack" id="pushMine" data-o="2"></section>' : ''}
      ${me.role === 'client' && sapOn() ? `<section class="card stack" data-o="7"><h2>Ne payer que 50 % ?</h2>
        <p class="small muted">Avec l'avance immédiate de l'URSSAF, le crédit d'impôt est déduit directement : vous ne payez que la moitié du ménage à domicile. Proprigo prépare ce service.</p>
        <label class="check"><input type="checkbox" id="wantAvance" ${me.wants_avance ? 'checked' : ''}> Prévenez-moi dès que c'est disponible</label></section>` : ''}
      ${me.role === 'intervenante' ? `<section class="card stack" data-o="3" id="ibanBox"><h2>🏦 Mon compte bancaire</h2><p class="small muted">Chargement…</p></section>` : ''}
      ${me.role === 'intervenante' ? `<section class="card stack" data-o="2">
        <h2>Ma présentation aux clients</h2>
        <p class="small muted">Vos clients voient votre photo, votre prénom et l'initiale de votre nom, votre nombre de ménages, votre note et ce texte. Jamais votre nom de famille complet ni votre téléphone.</p>
        <div class="av-edit">
          ${avatar(me.id, Boolean(card && card.avatar_status), me.name, 'lg')}
          <div>
            <p style="margin:0"><b>📷 Ma photo</b> ${card && card.avatar_status === 'valide' ? '<span class="pill ok">Visible des clients</span>' : card && card.avatar_status === 'a_verifier' ? '<span class="pill warn">En cours de vérification</span>' : ''}</p>
            <p class="small muted" style="margin:4px 0 8px">Une photo nette de votre visage, de face, avec le sourire. Elle est vérifiée par l'équipe avant d'être montrée.</p>
            <label class="btn ghost">${card && card.avatar_status ? 'Changer la photo' : 'Ajouter ma photo'}<input type="file" accept="image/*" id="avIn" hidden></label>
            ${card && card.avatar_status ? '<button type="button" class="linkish" id="avDel">Supprimer</button>' : ''}
          </div>
        </div>
        <form id="wprof" class="stack">
          <label>Quelques mots sur vous<textarea name="bio" rows="3" maxlength="300" placeholder="Ex. Sept ans d'expérience, j'aime les intérieurs nets et je fais attention aux objets fragiles.">${esc(card ? card.bio : '')}</textarea></label>
          <label>Langues parlées<input type="text" name="languages" maxlength="120" value="${esc(card ? card.languages : '')}" placeholder="Ex. français, arabe"></label>
          <button class="btn blue">Enregistrer ma présentation</button>
        </form>
      </section>` : ''}
        <section class="card stack" data-o="1">
          <h2>Mes informations</h2>
          <form id="info" class="stack">
            <label>Nom<input type="text" name="name" autocomplete="name" maxlength="80" value="${esc(me.name)}" required></label>
            <label>Téléphone<input type="tel" name="phone" autocomplete="tel" maxlength="20" value="${esc(me.phone || '')}"></label>
            <label>E-mail<input type="email" value="${esc(me.email)}" disabled></label>
            <p class="small muted" style="margin:0">Pour changer d'e-mail, écrivez à l'équipe Proprigo.</p>
            <button class="btn blue">Enregistrer</button>
          </form>
        </section>
        <section class="card stack" data-o="8">
          <h2>Mot de passe</h2>
          <form id="pw" class="stack">
            <label>Mot de passe actuel<input type="password" name="current" autocomplete="current-password" required></label>
            <label>Nouveau mot de passe (10 caractères minimum)<input type="password" name="password" autocomplete="new-password" minlength="10" required></label>
            <button class="btn blue">Changer le mot de passe</button>
          </form>
        </section>
      <button type="button" class="btn ghost full" id="logout2">Se déconnecter</button>
      <section class="card stack">
        <h2>Mes données</h2>
        <p class="small">Vos données servent seulement à organiser vos ménages. Détails dans la <a href="#/confidentialite">politique de confidentialité</a>.</p>
        ${me.role === 'client' ? `
        <details class="danger"><summary>Supprimer mon compte</summary>
          <p class="small">Votre nom, e-mail, téléphone, logements et photos seront effacés. Les factures des ménages passés sont gardées sans vos coordonnées (obligation légale). Les ménages à venir doivent d'abord être annulés. Cette action est définitive.</p>
          <form id="del" class="stack">
            <label>Votre mot de passe, pour confirmer<input type="password" name="password" autocomplete="current-password" required></label>
            <button class="btn danger">Supprimer définitivement mon compte</button>
          </form>
        </details>` : me.role === 'admin' ? '<p class="small muted">Compte administrateur : choisissez un mot de passe long et unique avant de partager le site.</p>' : `
        <details class="danger"><summary>Supprimer mon compte</summary>
          <p class="small">L'équipe ferme votre compte sous 30 jours, une fois vos dernières missions payées. Vos documents sont effacés ; les relevés de paiement sont gardés le temps exigé par la loi.</p>
          <form id="delReq" class="stack">
            <label>Votre mot de passe, pour confirmer<input type="password" name="password" autocomplete="current-password" required></label>
            <button class="btn danger">Demander la suppression de mon compte</button>
          </form>
        </details>`}
      </section>`;
    if (ref) {
      const text = `Je te recommande Proprigo pour le ménage : ${ref.amount} € offerts sur ton premier ménage avec mon code ${ref.code}.`;
      document.getElementById('copyRef').onclick = async () => { try { await navigator.clipboard.writeText(ref.link); toast('Lien copié.'); } catch { toast(ref.link); } };
      document.getElementById('shareRef').onclick = async () => {
        if (navigator.share) { try { await navigator.share({ title: 'Proprigo', text, url: ref.link }); } catch { /* partage annulé */ } }
        else { try { await navigator.clipboard.writeText(`${text} ${ref.link}`); toast('Message copié : collez-le dans un SMS ou WhatsApp.'); } catch { toast(ref.link); } }
      };
    }
    paintPush(document.getElementById('pushMine'), 'Soyez prévenu quand votre intervenante est en route, et de tout changement sur vos ménages.');
    const wa = document.getElementById('wantAvance');
    if (wa) wa.onchange = async () => { try { const r = await api('POST', '/api/me/avance', { wants: wa.checked }); toast(r.message); me.wants_avance = wa.checked ? 1 : 0; } catch (e) { toast(e.message); } };
    const cf = document.getElementById('companyForm');
    if (cf) {
      api('GET', '/api/account/company').then((c) => {
        for (const k of ['company', 'siret', 'vat_number', 'billing_address']) cf[k].value = c[k] || '';
        if (c.company) document.getElementById('companyBox').open = true;
        document.getElementById('volumeInfo').textContent = c.company ? `Ce mois-ci : ${c.monthCount} prestation${c.monthCount > 1 ? 's' : ''}. ${c.volume ? `Remise volume active : −${Math.round(c.volume * 100)} % sur les bureaux et logements Airbnb.` : `Remise de 5 % à partir de 10 prestations dans le mois (bureaux et logements Airbnb).`}` : '';
      }).catch(() => {});
      cf.onsubmit = async (e) => { e.preventDefault(); try { const r = await api('POST', '/api/account/company', formData(cf)); toast(r.message); route(); } catch (err) { toast(err.message); } };
    }
    const rd = document.getElementById('redeem2');
    if (rd) rd.onsubmit = async (e) => { e.preventDefault(); try { const r = await api('POST', '/api/gifts/redeem', { code: rd.code.value }); toast(r.message); document.getElementById('myCredit').textContent = eur(r.credit); rd.reset(); } catch (err) { toast(err.message); } };
    const ibanBox = document.getElementById('ibanBox');
    if (ibanBox) api('GET', '/api/worker/iban').then((ib) => {
      ibanBox.innerHTML = `<h2>🏦 Mon compte bancaire</h2>
        <p class="small muted">Pour recevoir vos versements. ${ib.iban ? `Compte enregistré : <b data-notr>${esc(ib.iban)}</b>${ib.name ? ` (${esc(ib.name)})` : ''}.` : 'Aucun compte enregistré.'} L'équipe est prévenue à chaque changement.</p>
        <form id="ibanForm" class="stack"><label>IBAN<input name="iban" autocomplete="off" inputmode="text" placeholder="FR76 …" required></label>
          <label>Titulaire du compte<input name="name" maxlength="70" value="${esc(ib.name || me.name)}" required></label>
          <button class="btn blue">${ib.iban ? 'Changer de compte' : 'Enregistrer mon IBAN'}</button></form>`;
      document.getElementById('ibanForm').onsubmit = async (e) => { e.preventDefault(); try { const r = await api('POST', '/api/worker/iban', formData(e.target)); toast(r.message); route(); } catch (err) { toast(err.message); } };
    }).catch(() => {});
    const avIn = document.getElementById('avIn');
    if (avIn) avIn.onchange = async () => {
      const f = avIn.files[0]; if (!f) return;
      try { toast('Envoi de la photo…'); const r = await api('POST', '/api/worker/avatar', { data: await squareShrink(f) }); toast(r.message); route(); } catch (e) { toast(e.message); }
    };
    const avDel = document.getElementById('avDel');
    if (avDel) avDel.onclick = async () => { if (!confirm('Supprimer votre photo ?')) return; try { const r = await api('POST', '/api/worker/avatar/remove', {}); toast(r.message); route(); } catch (e) { toast(e.message); } };
    const wp = document.getElementById('wprof');
    if (wp) wp.onsubmit = async (e) => { e.preventDefault(); try { const r = await api('POST', '/api/worker/profile', formData(wp)); toast(r.message); } catch (err) { toast(err.message); } };
    { // ordre d'affichage : d'abord ce qu'on cherche le plus souvent
      const tagged = [...$app.querySelectorAll(':scope > [data-o]')].sort((x, y) => Number(x.dataset.o) - Number(y.dataset.o));
      const anchor = document.getElementById('logout2');
      tagged.forEach((el) => $app.insertBefore(el, anchor));
    }
    document.getElementById('logout2').onclick = async () => { await nativeForget(); await api('POST', '/api/logout', {}); me = null; renderNav(); go('#/'); route(); };
    document.getElementById('info').onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api('POST', '/api/account', formData(e.target)); await loadMe(); renderNav(); toast(r.message); } catch (err) { toast(err.message); }
    };
    document.getElementById('pw').onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api('POST', '/api/account/password', formData(e.target)); e.target.reset(); toast(r.message); } catch (err) { toast(err.message); }
    };
    const del = document.getElementById('del');
    if (del) del.onsubmit = async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/account/delete', formData(e.target)); me = null; toast('Votre compte est supprimé.'); go('#/'); } catch (err) { toast(err.message); }
    };
    const delReq = document.getElementById('delReq');
    if (delReq) delReq.onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api('POST', '/api/account/delete-request', formData(e.target)); toast(r.message); e.target.closest('details').innerHTML = `<p class="msg ok">${esc(r.message)}</p>`; } catch (err) { toast(err.message); }
    };
  };

  // ---------- pages d'information (textes à faire valider par un avocat) ----------
  const DRAFT_NOTE = '<p class="notice">Projet de texte, à faire relire par un avocat avant l\'ouverture. Les passages entre crochets sont à compléter.</p>';
  const page = (title, body) => { $app.innerHTML = `<article class="card legal"><h1>${title}</h1>${body}</article>`; };

  views['aide'] = () => {
    if (me && me.role === 'intervenante') return aideIntervenante();
    if (me && me.role === 'admin') return aideAdmin();
    const faq = [
      ['Comment réserver ?', 'Cliquez sur « Réserver », choisissez le type de ménage, puis la date et l\'heure parmi les créneaux réellement libres. Vous voyez le prix total avant de payer.'],
      ['Puis-je annuler ?', "Oui, depuis « Mes réservations ». L'annulation est gratuite jusqu'à 24 h avant le ménage. Moins de 24 h avant, 50 % du prix est retenu, car l'intervenante a réservé ce créneau pour vous."],
      ['Puis-je changer la date ou l\'heure ?', 'Oui, avec « Modifier », jusqu\'à 24 h avant. Le prix est recalculé (par exemple un dimanche) et nous vérifions qu\'une intervenante est libre. Moins de 24 h avant, écrivez-nous dans la messagerie de la réservation.'],
      ['Qui vient chez moi ?', "Une intervenante sélectionnée et vérifiée par Proprigo (identité, entretien, formation). Vous voyez son prénom avant le ménage. Après un ménage, vous pouvez la garder comme intervenante préférée."],
      ['Et si elle est absente ?', 'Nous cherchons automatiquement une remplaçante vérifiée et vous prévenons par e-mail et dans la messagerie. Si vous préférez garder votre intervenante, vous pouvez choisir un autre créneau où elle est libre.'],
      ['Faut-il fournir le matériel ?', `Pour un ménage à domicile, vous pouvez fournir aspirateur et produits, ou choisir l'option « matériel fourni » (+${String(PRICES().kit).replace('.', ',')} €). Pour un logement Airbnb, le matériel reste dans le logement.`],
      ['Les photos sont-elles obligatoires ?', "Non. Les photos avant / après ne sont prises que si vous l'acceptez. Seuls vous et l'équipe Proprigo pouvez les voir, et elles sont supprimées après 90 jours."],
      ['Comment payer ?', "Par carte, au moment de la réservation. Paiement sécurisé via Stripe avant chaque intervention. Le reçu est disponible dans « Mes réservations » une fois le ménage terminé."],
      ['Le ménage ne me convient pas, que faire ?', 'Dans les 48\u00a0h, cliquez sur « On revient » sous le ménage dans « Mes réservations » : une intervenante revient gratuitement reprendre les points oubliés. Pour un autre souci (objet abîmé, retard…), utilisez « Signaler un problème » : notre équipe vous répond rapidement.'],
    ];
    page('Aide et réclamations', `
      <p class="lead">Les réponses aux questions les plus fréquentes. Pour un ménage précis, le plus rapide est la messagerie de la réservation.</p>
      ${faq.map(([q, a]) => `<details class="faq"><summary>${q}</summary><p>${a}</p></details>`).join('')}
      <h2>Faire une réclamation</h2>
      <ol><li>Ouvrez <a href="#/mes-reservations">Mes réservations</a>.</li><li>Sous le ménage concerné, cliquez sur « Signaler un problème » et décrivez la situation, avec une photo si possible.</li><li>Notre équipe vous répond dans la messagerie de la réservation, et par e-mail.</li></ol>
      <p>Si la réponse ne vous satisfait pas, vous pouvez saisir gratuitement le médiateur de la consommation : [NOM ET SITE DU MÉDIATEUR].</p>
      <h2>Nous contacter</h2><p>Le plus rapide : la messagerie de votre réservation. Sinon, par e-mail : <a href="mailto:contact@proprigo.fr">contact@proprigo.fr</a>.</p>`);
  };
  // aide de l'espace responsable : comment faire les tâches courantes
  function aideAdmin() {
    const faq = [
      ['Par où commencer chaque jour ?', "Ouvrez l'onglet « À traiter » : les réservations sans intervenante, les problèmes signalés, les candidatures et les documents à vérifier. Quand cet onglet est vide, tout est à jour."],
      ["Une réservation n'a pas d'intervenante", "Dans « À traiter » ou « Réservations », cliquez sur « Choisir l'intervenante ». Choisissez parmi les intervenantes proposées pour ce créneau."],
      ['Une intervenante est absente', "Dans « Équipe », cliquez sur « Marquer absente » à côté de son nom : ses ménages prévus repassent dans « À traiter » pour choisir une remplaçante. Si elle n'a pas prévenu, utilisez aussi « Absence non prévenue » : cela compte pour son niveau."],
      ['Un client signale un problème', "Il apparaît dans « À traiter ». Répondez avec « Écrire au client », puis choisissez : « Créer le retour gratuit », « Annuler et rembourser », ou « Marquer traité » si c'est réglé."],
      ['Recruter une intervenante', "Les candidatures arrivent dans « Équipe ». Vérifiez ses documents (« Voir », puis « Valider » ou « Refuser ce document »), faites l'entretien, puis validez chaque étape. Vous pouvez aussi créer un compte vous-même avec « Créer le compte intervenante »."],
      ['Payer les indépendantes', "Chaque semaine, l'onglet « Chiffres » montre ce qui est dû pour la semaine passée, pourboires et bonus Platine compris. Téléchargez le fichier de virements groupés (SEPA) pour votre banque, faites le virement, puis cliquez sur « J'ai fait le virement : tout marquer versé »."],
      ['Payer les salariées', "Dans « Chiffres », téléchargez « Paie des salariées (CSV) » du mois et envoyez-le à votre comptable ou à votre logiciel de paie."],
      ["Changer le tarif d'une indépendante", "Dans « Équipe », ouvrez sa fiche et utilisez « Changer le tarif ». Uniquement avec son accord écrit : les ménages déjà faits restent payés à l'ancien tarif."],
      ['Changer les prix pour les clients', "Onglet « Tarifs et zones ». Les nouveaux prix s'appliquent aux nouvelles réservations ; celles déjà faites gardent leur prix. Un prix trop bas qui ferait perdre de l'argent est refusé."],
      ['Rembourser un client', "Onglet « Paiements » ou depuis la réservation avec « Annuler et rembourser » : le remboursement part sur sa carte via Stripe. Si vous l'avez déjà fait dans Stripe, cliquez sur « Déjà remboursé dans Stripe »."],
      ['Donner accès à une secrétaire', "Dans « Équipe », « Créer un compte planning » : elle peut gérer les réservations et le planning, mais ne voit ni les chiffres, ni les coordonnées complètes des clients."],
      ['Sauvegarder les données', "Onglet « Suivi », « Sauvegardes » : une sauvegarde est faite chaque jour. Gardez aussi une copie hors du serveur (voir le guide de mise en ligne)."],
    ];
    page('Aide du responsable', `
      <p class="lead">Comment faire les tâches courantes de l'administration. Les clients et les intervenantes ont chacun leur propre page d'aide.</p>
      ${faq.map(([q, a]) => `<details class="faq"><summary>${q}</summary><p>${a}</p></details>`).join('')}
      <h2>Voir ce que voient les autres</h2>
      <p>Pour vérifier un écran client ou intervenante, connectez-vous avec un compte de test dans une fenêtre de navigation privée.</p>`);
  }
  // choix de la langue de l'espace intervenante
  const langPicker = () => window.PROPRIGO_I18N ? `<label class="lang-pick"><span>🌐 Langue</span><select id="langPick" data-notr>${window.PROPRIGO_I18N.LANGS.map(([k, n]) => `<option value="${k}" ${(me && me.lang || 'fr') === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>` : '';
  document.addEventListener('change', async (e) => {
    if (!e.target || e.target.id !== 'langPick') return;
    const lang = e.target.value;
    try { await api('POST', '/api/me/lang', { lang }); me.lang = lang; applyLang(); route(); } catch (err) { toast(err.message); }
  });
  function applyLang() {
    if (!window.PROPRIGO_I18N) return;
    window.PROPRIGO_I18N.set(me && me.role === 'intervenante' ? (me.lang || 'fr') : 'fr');
  }
  // aide des intervenantes : leurs questions à elles, pas celles des clients
  function aideIntervenante() {
    const faq = [
      ['Comment je reçois mes missions ?', "Indépendante : vous recevez des propositions dans « Missions », avec le prix, la date et le code postal. Vous acceptez celles qui vous conviennent ; refuser n'entraîne aucune pénalité. L'adresse exacte s'affiche après acceptation. Salariée : le planning Proprigo vous attribue les missions selon vos disponibilités."],
      ['Comment être prévenue des nouvelles missions ?', "Activez les notifications dans « Missions », rubrique « Notifications ». Vous êtes prévenue sur votre téléphone, même l'application fermée."],
      ['Comment indiquer mes horaires et mes congés ?', "Dans « Missions » : « Mes disponibilités » pour vos jours et horaires de travail, « Mes congés » pour vos absences. Vous ne recevez aucune mission en dehors de ces horaires ni pendant vos congés."],
      ['Le jour de la mission, que dois-je faire ?', "Appuyez sur 🚶 « Je pars » en partant et indiquez dans combien de temps vous arrivez : le client est prévenu. Puis 📍 « Je suis arrivée », ▶ « Commencer le ménage », et ✅ « Terminer le ménage » à la fin. Cochez les tâches au fur et à mesure."],
      ['Je vais être en retard, que faire ?', "Ouvrez 💬 « Messages » sur la mission et envoyez « J'aurai environ 15 min de retard ». Vous pouvez aussi changer l'heure d'arrivée prévue après « Je pars »."],
      ['Il y a un problème chez le client', "Appuyez sur ⚠️ « Problème » sur la mission : accès impossible, objet cassé, logement bien plus sale que prévu, ou si vous ne vous sentez pas en sécurité. L'équipe est prévenue tout de suite. En cas de danger, appelez le 17."],
      ['Les photos sont-elles obligatoires ?', "Seulement si le client les a acceptées. Dans ce cas, prenez au moins une 📷 « Photo après » avant de terminer. Sinon, aucune photo n'est demandée."],
      ['Quand suis-je payée ?', "Indépendante : par virement chaque semaine pour les ménages terminés. Salariée : votre salaire figure sur votre fiche de paie. Dans les deux cas, « Mes gains » montre vos heures mois par mois."],
      ['Je ne peux pas venir à une mission', "Prévenez l'équipe le plus tôt possible par e-mail à contact@proprigo.fr, en donnant la date et l'adresse de la mission. Une remplaçante sera cherchée pour le client. Pour une absence prévue, ajoutez-la dans « Mes congés »."],
      ['Où envoyer mes documents ?', "Dans « Missions », rubrique « Mes documents ». Vous pouvez envoyer une photo ou un PDF depuis votre téléphone."],
    ];
    page('Aide', `
      <p class="lead">Les réponses aux questions les plus fréquentes. Pour une mission précise, écrivez dans les 💬 messages de la mission.</p>
      ${faq.map(([q, a]) => `<details class="faq"><summary>${q}</summary><p>${a}</p></details>`).join('')}
      <h2>Contacter l'équipe</h2><p>Par la messagerie d'une mission, ou par e-mail : <a href="mailto:contact@proprigo.fr">contact@proprigo.fr</a>.</p>`);
  }

  views['intervenantes-verifiees'] = () => page('Nos intervenantes', `
    <p class="lead">Une intervenante ne reçoit aucune mission avant d'avoir passé toutes les étapes de sélection.</p>
    <ol class="check-list"><li><b>Vérification de l'identité</b> et de l'autorisation de travailler en France.</li><li><b>Vérification du statut</b> : contrat de travail Proprigo, ou numéro SIRET et attestation URSSAF pour une indépendante.</li><li><b>Entretien</b> avec notre équipe.</li><li><b>Vérification de l'expérience</b>.</li><li><b>Formation</b> aux standards de ménage Proprigo (salariées).</li><li><b>Première mission accompagnée</b>.</li><li><b>Suivi de la qualité</b> : chaque note inférieure à 4 sur 5 est traitée par l'équipe.</li></ol>
    <h2>Assurance</h2><p>Les prestations sont couvertes par une assurance responsabilité civile professionnelle : [NOM DE L'ASSUREUR, NUMÉRO DE CONTRAT]. Une assurance ne couvre pas automatiquement tous les incidents ; les conditions sont détaillées dans les <a href="#/cgv">conditions générales</a>.</p>
    <h2>Remplacement garanti</h2><p>En cas d'absence de votre intervenante, nous cherchons automatiquement une remplaçante vérifiée et vous prévenons. Vous pouvez aussi choisir un autre créneau pour la garder.</p>`);

  views['cgv'] = () => page('Conditions générales de vente', `${DRAFT_NOTE}
    <h2>1. Objet</h2><p>Les présentes conditions encadrent les prestations de ménage réservées sur Proprigo par des particuliers et des professionnels (hôtes et conciergeries), exploité par [RAISON SOCIALE], [FORME JURIDIQUE] au capital de [MONTANT], immatriculée sous le numéro [SIREN], siège : [ADRESSE].</p>
    <h2>2. Prestations</h2><p>Ménage à domicile à l'heure, grand nettoyage, ménage de logement de location courte durée au forfait (ménage et linge). Les tâches prévues figurent dans la checklist de la réservation. Les prestations sont réalisées par des intervenantes salariées de Proprigo ou des intervenantes indépendantes sélectionnées.</p>
    <h2>3. Prix</h2><p>Les prix sont indiqués en euros toutes taxes comprises avant la réservation. Suppléments : dimanche et jours fériés +${pct(PRICES().sunday)}, intervention urgente (arrivée dans les 3 heures) +${pct(PRICES().urgent)}, matériel et produits fournis +${String(PRICES().kit).replace('.', ',')} €. [Le crédit d'impôt de 50 % s'applique aux services à la personne selon les conditions légales, une fois la déclaration de l'entreprise effectuée.]</p>
    <h2>4. Réservation et paiement</h2><p>Le client paie via Stripe avant l'intervention. Le créneau demandé reste soumis à l'attribution d'une intervenante par PROPRIGO. Le client est informé après attribution. Si aucune intervenante ne peut être trouvée, PROPRIGO annule la prestation et rembourse intégralement le paiement. Le client s'engage à donner une adresse exacte et l'accès au logement à l'heure prévue.</p>
    <h2>5. Modification et annulation</h2><p>La date, l'heure, la durée et l'adresse peuvent être modifiées jusqu'à 24 heures avant le début de la prestation, sous réserve de disponibilité ; le prix est recalculé. L'annulation est gratuite jusqu'à 24 heures avant ; ensuite, 50 % du prix reste dû. Si l'intervenante ne peut pas accéder au logement du fait du client, la prestation est due.</p>
    <h2>6. Droit de rétractation</h2><p>Pour une réservation faite à distance par un consommateur, le droit de rétractation de 14 jours s'applique. Si le client demande que la prestation commence avant la fin de ce délai, il le reconnaît expressément et reste redevable du montant correspondant au service fourni. [Rédaction à valider.]</p>
    <h2>7. Remplacement de l'intervenante</h2><p>En cas d'indisponibilité de l'intervenante prévue, Proprigo peut la remplacer par une autre intervenante vérifiée et en informe le client, qui peut choisir un autre créneau.</p>
    <h2>8. Qualité, garantie et réclamations</h2><p><b>Garantie « satisfait ou on revient »</b> : si une prestation terminée ne vous satisfait pas, signalez-le dans les 48 heures suivant sa fin, depuis la réservation (bouton « On revient »), en précisant les points concernés. Proprigo revient gratuitement reprendre ces points, à un créneau convenu avec vous. La garantie s'applique une fois par prestation et couvre les tâches prévues à la réservation. Toute autre réclamation se fait dans les mêmes 48 heures depuis « Signaler un problème » ; Proprigo propose alors une solution adaptée (nouveau passage, geste commercial).</p>
    <h2>9. Responsabilité et assurance</h2><p>Proprigo est assuré en responsabilité civile professionnelle auprès de [ASSUREUR]. Le client signale les objets fragiles ou de valeur. [Limites et exclusions à préciser avec l'assureur, notamment pour les vols.]</p>
    <h2>10. Photos et données personnelles</h2><p>Voir la <a href="#/confidentialite">politique de confidentialité</a>.</p>
    <h2>11. Médiation et droit applicable</h2><p>En cas de litige, le consommateur peut recourir gratuitement au médiateur : [NOM, ADRESSE, SITE]. Droit français.</p>`);

  views['mentions-legales'] = () => {
    const L = CONFIG.legal || {};
    const v = (k, ph) => (L[k] ? esc(L[k]) : `[${ph}]`);
    const forme = L.formeJuridique || '';
    const societe = /SAS|SARL|EURL|SA\b/i.test(forme);
    const editeur = societe
      ? `${v('raisonSociale', 'RAISON SOCIALE')}, ${esc(forme)} au capital de ${v('capital', 'MONTANT')}, ${L.rcs ? `RCS ${esc(L.rcs)}` : '[RCS VILLE ET NUMÉRO]'}, SIRET ${v('siret', 'SIRET')}, siège : ${v('adresse', 'ADRESSE')}.`
      : `${v('raisonSociale', 'PRÉNOM NOM EI')}${forme ? `, ${esc(forme)}` : ''}, SIRET ${v('siret', 'SIRET')}, adresse : ${v('adresse', 'ADRESSE')}.`;
    const tva = CONFIG.franchiseTVA ? 'TVA non applicable, art. 293 B du CGI.' : `TVA intracommunautaire : ${v('tvaIntracom', 'NUMÉRO')}.`;
    const complet = L.raisonSociale && L.siret && L.adresse && (!societe || (L.capital && L.rcs)) && L.president;
    page('Mentions légales', `${complet ? '' : DRAFT_NOTE}
    <p><b>Éditeur</b> : ${editeur} ${tva}</p>
    <p><b>${societe ? 'Président et directeur' : 'Directeur'} de la publication</b> : ${v('president', 'NOM')}.</p>
    <p><b>Contact</b> : ${v('emailContact', 'ADRESSE E-MAIL')}${L.telephone ? `, ${esc(L.telephone)}` : ''}.</p>
    <p><b>Hébergeur</b> : ${L.hebergeur ? esc(L.hebergeur) : 'Render Services, Inc., 525 Brannan Street, Suite 300, San Francisco, CA 94107, États-Unis (render.com).'}</p>
    <p><b>Déclaration services à la personne</b> : ${CONFIG.sap && CONFIG.sap.declared ? `n° ${esc(CONFIG.sap.numero)}` : '[NUMÉRO DE DÉCLARATION NOVA, une fois obtenu]'}.</p>
    <p><b>Propriété intellectuelle</b> : la marque ${v('nomCommercial', 'Proprigo')}, le logo et les contenus du site sont la propriété de ${v('raisonSociale', 'RAISON SOCIALE')}.</p>`);
  };

  views['confidentialite'] = () => page('Politique de confidentialité', `${DRAFT_NOTE}
    <p><b>Responsable du traitement</b> : [RAISON SOCIALE], [ADRESSE]. Contact pour vos données : [E-MAIL].</p>
    <h2>Données collectées et pourquoi</h2>
    <ul><li><b>Compte</b> : nom, e-mail, téléphone, mot de passe chiffré, pour gérer votre compte et vos réservations.</li>
    <li><b>Réservations</b> : adresse, date, consignes, checklist, pour réaliser le ménage. L'adresse et les consignes ne sont visibles que par l'intervenante qui a la mission.</li>
    <li><b>Messages</b> : échanges liés à une réservation. Les numéros de téléphone et e-mails écrits dans un message sont masqués.</li>
    <li><b>Photos avant / après</b> : seulement avec votre accord, visibles par vous et l'équipe, <b>supprimées automatiquement après 90 jours</b>.</li>
    <li><b>Intervenantes</b> : identité, statut, disponibilités, documents demandés étape par étape pendant le recrutement, pour la sélection et l'organisation des missions.</li>
    <li><b>Paiement</b> : géré par [PRESTATAIRE DE PAIEMENT] ; Proprigo ne conserve pas vos numéros de carte.</li></ul>
    <h2>Durées de conservation</h2><p>Compte : jusqu'à sa suppression, puis [3 ans] pour la prospection. Factures : 10 ans (obligation légale). Candidatures non retenues : [2 ans maximum]. Photos : 90 jours. [À valider.]</p>
    <h2>Destinataires</h2><p>L'équipe Proprigo, l'intervenante de la mission, nos sous-traitants techniques (hébergement [NOM], e-mails [NOM], paiement [NOM]). Aucune revente de données.</p>
    <h2>Vos droits</h2><p>Accès, rectification, effacement, opposition, limitation, portabilité : écrivez à [E-MAIL]. Vous pouvez aussi saisir la CNIL (cnil.fr).</p>
    <h2>Cookies</h2><p>Proprigo n'utilise qu'un cookie de session, nécessaire à la connexion. Aucun cookie publicitaire.</p>`);

  // ---------- routeur ----------
  // installation sur l'écran d'accueil (service minimal, sans cache)
  if (!NATIVE && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  async function route() {
    renderNav();
    const [name, qs] = location.hash.replace(/^#\/?/, '').split('?');
    const view = views[name] || views[''];
    try { await view(new URLSearchParams(qs || '')); } catch (e) { $app.innerHTML = `<p class="card err">${esc(e.message)}</p>`; }
    verifyBanner(name);
    $app.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', route);
  // Re-fetch server state on return from Stripe, focus, and while a dashboard is visible.
  // A refresh must not require logging out and back in.
  let refreshInProgress = false;
  async function refreshDashboard() {
    if (refreshInProgress || document.hidden || !me) return;
    const page = location.hash.replace(/^#\/?/, '').split('?')[0];
    if (!['mes-reservations', 'admin', 'intervenante'].includes(page)) return;
    // Ne jamais effacer une saisie en cours (tarifs, mois choisi, formulaire, fenêtre ouverte).
    const a = document.activeElement;
    if (a && $app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    if (document.querySelector('dialog[open]') || $app.querySelector('details[open]')) return;
    if (page === 'admin' && ['tarifs', 'paiements', 'chiffres'].includes(sessionStorage.getItem('adminTab'))) return;
    refreshInProgress = true;
    try { await route(); } finally { refreshInProgress = false; }
  }
  window.addEventListener('focus', refreshDashboard);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDashboard(); });
  setInterval(refreshDashboard, 15000);
  loadMe().catch(() => {}).finally(route);
})();
