'use strict';
// Proprigo — interface (client, intervenante, administrateur). Aucune bibliothèque externe.
(() => {
  const $app = document.getElementById('app');
  const $nav = document.getElementById('nav');
  let me = null;

  // ---------- outils ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const eur = (n) => { const v = Number(n); return v.toLocaleString('fr-FR', Number.isInteger(v) ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '\u00a0€'; };
  const dateFr = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const todayParis = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
  const SIZE = { studio: 'Studio', T2: 'T2', T3: 'T3', maison: 'Maison' };
  const SERVICE = { menage: 'Ménage', grand: 'Grand nettoyage', airbnb: 'Ménage Airbnb' };
  const STATUS = {
    en_attente: ['Recherche en cours', 'warn'], proposee: ['Recherche en cours', 'warn'], attribuee: ['Confirmée', ''],
    en_cours: ['En cours', ''], terminee: ['Terminée', 'ok'], annulee: ['Annulée', 'gray'],
  };
  const PAY = { simule: 'Paiement simulé (version de test)', paye: 'Payé', a_rembourser: 'Remboursement en cours', rembourse: 'Remboursé' };
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
  function renderNav() {
    const links = [];
    if (!me) links.push('<a href="#/inscription-intervenante">Devenir intervenante</a>', '<a href="#/connexion">Se connecter</a>', '<a class="cta" href="#/reserver">Réserver</a>');
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
    if (lo) lo.onclick = async () => { await api('POST', '/api/logout', {}); me = null; go('#/'); route(); };
  }

  async function loadMe() {
    const r = await api('GET', '/api/me');
    me = r.user;
  }

  const views = {};

  const AIR_HOURS = { studio: 2, T2: 2.5, T3: 3, maison: 4 };
  const DEFAULT_TASKS = {
    menage: ['Cuisine : plans de travail, évier, extérieur des appareils', 'Salle de bain et WC', 'Sols : aspirateur et serpillière', 'Poussière des surfaces', 'Vider les poubelles'],
  };
  DEFAULT_TASKS.grand = [...DEFAULT_TASKS.menage, 'Intérieur du four et du réfrigérateur', 'Vitres accessibles', 'Intérieur des placards'];
  DEFAULT_TASKS.airbnb = [...DEFAULT_TASKS.menage, 'Changer les draps et les serviettes', 'Faire les lits', 'Réassort : papier toilette, savon, café', "Vérifier l'état du logement et signaler tout dégât"];
  const WEEKDAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const HALF_HOURS = Array.from({ length: 29 }, (_, i) => `${String(6 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
  const draftHours = (d) => (d.service === 'airbnb' ? AIR_HOURS[d.size] : Number(d.hours));

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

  const tomorrowParis = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(Date.now() + 864e5));
  const DRAFT0 = () => ({ step: 1, service: 'menage', size: 'T2', hours: 3, kit: false, cp: '', address: '', date: tomorrowParis(), time: null, urgent: false, repeat: '0', occurrences: 8, photoConsent: false, tasks: null, tasksService: null, home_id: null, cgv: false });
  let draft = DRAFT0();
  const FREE_CANCEL = "Annulation gratuite jusqu'à 24 h avant le ménage. Ensuite, 50 % du prix est retenu.";
  const ICON = {
    menage: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 11.5 12 4l8.5 7.5M6 10v10h12V10"/><path d="M10 20v-5h4v5"/></svg>',
    grand: '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true"><path d="M12 2.5c.6 4.6 2.3 6.4 7 7-4.7.6-6.4 2.4-7 7-.6-4.6-2.3-6.4-7-7 4.7-.6 6.4-2.4 7-7z"/><path d="M19 15.5c.25 1.9.9 2.6 2.8 2.8-1.9.25-2.55.9-2.8 2.8-.25-1.9-.9-2.55-2.8-2.8 1.9-.2 2.55-.9 2.8-2.8z"/></svg>',
    airbnb: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3.5M21 12v2.5"/></svg>',
  };
  const SERVICE_HINT = { menage: 'Ménage courant, à l\'heure', grand: 'Fin de bail, remise en état', airbnb: 'Forfait ménage + linge' };
  const dateLong = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

  // ---------- accueil ----------
  views[''] = async () => {
    if (me && me.role === 'intervenante') return go('#/intervenante');
    if (me && me.role === 'admin') return go('#/admin');
    if (me && me.role === 'client') return clientHome();
    $app.innerHTML = `
      <section class="hero">
        <div class="stack">
          <h1>Un intérieur propre, sans complication.</h1>
          <p class="lead">Réservez votre ménage en quelques minutes, avec des intervenantes vérifiées. Le prix est affiché avant de payer.</p>
          <ul class="trust"><li>✓ Intervenantes sélectionnées et vérifiées</li><li>✓ Annulation gratuite jusqu'à 24 h avant</li><li>✓ Remplaçante garantie en cas d'absence</li></ul>
        </div>
        <form class="card stack choose" id="start">
          <h2>De quel ménage avez-vous besoin ?</h2>
          <div class="svc">${['menage', 'airbnb', 'grand'].map((k) => `<button type="button" data-pick="${k}" aria-pressed="${draft.service === k}">${ICON[k]}<b>${k === 'menage' ? 'À domicile' : SERVICE[k]}</b><span>${SERVICE_HINT[k]}</span></button>`).join('')}</div>
          <label>Code postal du logement<input type="text" name="cp" inputmode="numeric" maxlength="5" autocomplete="postal-code" value="${esc(draft.cp)}" placeholder="75011" required></label>
          <p class="msg" id="zone"></p>
          <button class="btn primary full">Voir les disponibilités</button>
        </form>
      </section>
      <section class="steps3">
        <div><b>1. Choisissez</b><span>Votre ménage, la date et l'heure parmi les créneaux réellement libres.</span></div>
        <div><b>2. Une intervenante vérifiée vient</b><span>Vous connaissez son prénom avant le ménage et la retrouvez la fois suivante.</span></div>
        <div><b>3. Vous suivez tout</b><span>Messages, checklist, photos avant / après si vous le souhaitez, reçu.</span></div>
      </section>`;
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
  const TRACK = ['Réservé', 'Intervenante confirmée', 'Ménage en cours', 'Terminé'];
  const trackIndex = (s) => ({ en_attente: 0, proposee: 0, attribuee: 1, en_cours: 2, terminee: 3 }[s] ?? 0);
  function tracker(b) {
    const i = trackIndex(b.status);
    return `<ol class="track">${TRACK.map((t, k) => `<li class="${k < i ? 'done' : k === i ? 'now' : ''}">${t}</li>`).join('')}</ol>`;
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
      <div class="row"><h1>Bonjour ${esc(me.name.split(' ')[0])}</h1><a class="btn primary" href="#/reserver" id="newB">Réserver un ménage</a></div>
      ${next ? `
        <article class="card next">
          <p class="small muted" style="margin:0">${next.status === 'en_cours' ? 'En ce moment' : 'Prochain ménage'}</p>
          <h2 style="margin-top:4px">${esc(dateLong(next.date))} à ${esc(next.time)}</h2>
          ${tracker(next)}
          <dl class="facts">
            <div><dt>Intervenante</dt><dd>${next.worker_name ? `<b>${esc(next.worker_name.split(' ')[0])}</b>, intervenante vérifiée` : 'Nous confirmons votre intervenante très vite'}</dd></div>
            <div><dt>Adresse</dt><dd>${esc(next.address)}, ${esc(next.cp)}</dd></div>
            <div><dt>Prestation</dt><dd>${esc(label(next))} · <b>${eur(next.total)}</b></dd></div>
          </dl>
          ${next.ical_flagged && ['en_attente', 'proposee', 'attribuee'].includes(next.status) ? `<div class="notice"><b>Ce séjour n'apparaît plus dans le calendrier de votre annonce.</b> Le ménage reste prévu. Si le séjour est bien annulé, annulez le ménage ; sinon, gardez-le.<div class="actions"><button class="btn ghost" data-keep="${next.id}">Garder le ménage</button><button class="btn ghost" data-cancel="${next.id}">Annuler le ménage</button></div></div>` : ''}
          ${next.preferred_id && next.worker_id !== next.preferred_id ? `<p class="notice"><b>${esc(next.preferred_name)}, votre intervenante préférée, n'est pas disponible à ce créneau.</b> Une autre intervenante vérifiée viendra. Pour la garder, choisissez un autre créneau via « Modifier ».</p>` : ''}
          <div class="actions">
            ${['en_attente', 'proposee', 'attribuee'].includes(next.status) && (Date.parse(`${next.date}T${next.time}:00`) - Date.now()) / 36e5 >= 24 ? `<button class="btn ghost" data-edit="${next.id}">Modifier</button>` : ''}
            <button class="btn ghost" data-thread="${next.id}">Contacter${next.messages ? ` (${next.messages})` : ''}</button>
            <button class="btn ghost" data-again="${next.id}">Réserver à nouveau</button>
          </div>
          <div id="thread-${next.id}"></div>
        </article>` : `
        <article class="card empty"><h2>Aucun ménage prévu</h2><p class="muted">Réservez en quelques minutes : vous ne voyez que les créneaux réellement libres.</p>
          ${last ? `<button class="btn primary" data-again="${last.id}">Refaire le même ménage</button>` : '<a class="btn primary" href="#/reserver">Réserver un ménage</a>'}</article>`}
      ${upcoming.length > 1 ? `<section class="card"><h3>À venir</h3><ul class="plain">${upcoming.slice(1, 6).map((b) => `<li><span><b>${dateFr(b.date)}</b> ${esc(b.time)} · ${esc(label(b))}</span><span>${b.worker_name ? esc(b.worker_name.split(' ')[0]) : '<span class="muted">à confirmer</span>'}</span></li>`).join('')}</ul></section>` : ''}
      ${toRate ? `<section class="card"><h3>Comment s'est passé le ménage du ${dateFr(toRate.date)} ?</h3><div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-rate="${toRate.id}" data-stars="${n}" aria-label="${n} sur 5">★</button>`).join('')}</div></section>` : ''}
      <nav class="quick" aria-label="Raccourcis"><a href="#/mes-reservations">Toutes mes réservations et reçus</a><a href="#/logements">Mes logements</a><a href="#/aide">Aide et réclamations</a></nav>`;
    document.getElementById('newB').onclick = () => { draft = DRAFT0(); };
    $app.querySelectorAll('[data-again]').forEach((b) => b.onclick = () => rebook(list.find((x) => String(x.id) === b.dataset.again)));
    $app.querySelectorAll('[data-keep]').forEach((btn) => btn.onclick = async () => { try { const r = await api('POST', `/api/bookings/${btn.dataset.keep}/ical-keep`, {}); toast(r.message); route(); } catch (e) { toast(e.message); } });
    $app.querySelectorAll('[data-cancel]').forEach((btn) => btn.onclick = async () => { try { const r = await api('POST', `/api/bookings/${btn.dataset.cancel}/cancel`, {}); toast(r.message || 'Ménage annulé.'); route(); } catch (e) { toast(e.message); } });
    $app.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => { sessionStorage.setItem('openEdit', b.dataset.edit); go('#/mes-reservations'); });
    $app.querySelectorAll('[data-rate]').forEach((btn) => btn.onclick = async () => {
      try { await api('POST', `/api/bookings/${btn.dataset.rate}/rate`, { stars: Number(btn.dataset.stars) }); toast('Merci pour votre avis.'); route(); } catch (e) { toast(e.message); }
    });
    bindThreads([]);
  }

  // ---------- réservation en 4 étapes ----------
  const STEP_NAMES = ['Votre ménage', 'Date et heure', 'Récapitulatif', 'Paiement'];
  const stepper = (n) => `<ol class="stepper" aria-label="Étape ${n} sur 4">${STEP_NAMES.map((t, i) => `<li class="${i + 1 < n ? 'done' : i + 1 === n ? 'now' : ''}" ${i + 1 === n ? 'aria-current="step"' : ''}><span>${i + 1}</span>${t}</li>`).join('')}</ol>`;

  views['reserver'] = async () => {
    if (!me) { sessionStorage.setItem('after', '#/reserver'); return go('#/inscription'); }
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
    const tasks = () => {
      if (draft.tasks && draft.tasksService === draft.service) return draft.tasks;
      const prev = past.find((b) => b.service === draft.service && draft.address && b.address === draft.address && b.checklist.length);
      draft.tasks = prev ? prev.checklist.map((t) => t.task) : [...DEFAULT_TASKS[draft.service]];
      draft.tasksService = draft.service;
      return draft.tasks;
    };
    const quote = () => api('POST', '/api/quote', { service: draft.service, size: draft.size, hours: draft.hours, cp: draft.cp, date: draft.date, time: draft.time, urgent: !!draft.urgent, kit: !!draft.kit });
    const shell = (inner, n) => { $app.innerHTML = `<section class="card wizard">${stepper(n)}${inner}</section>`; window.scrollTo(0, 0); };

    // Étape 1 : la prestation
    const step1 = () => {
      const t = tasks();
      shell(`
        <h1>Votre ménage</h1>
        ${homes.length ? `<label>Logement<select id="homeSel"><option value="">Autre adresse</option>${homes.map((h) => `<option value="${h.id}" ${draft.home_id === h.id ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</select></label>` : ''}
        <div class="svc">${['menage', 'grand', 'airbnb'].map((k) => `<button type="button" data-svc="${k}" aria-pressed="${draft.service === k}">${ICON[k]}<b>${SERVICE[k]}</b><span>${SERVICE_HINT[k]}</span></button>`).join('')}</div>
        ${draft.service === 'airbnb'
          ? `<fieldset class="box"><legend>Taille du logement</legend><div class="chips">${Object.keys(SIZE).map((k) => `<button type="button" data-size="${k}" aria-pressed="${draft.size === k}">${SIZE[k]}</button>`).join('')}</div></fieldset>`
          : `<label>Durée<select id="hours">${[2, 2.5, 3, 3.5, 4, 5, 6, 7, 8].map((h) => `<option value="${h}" ${Number(draft.hours) === h ? 'selected' : ''}>${String(h).replace('.', ',')} h</option>`).join('')}</select></label>
             <p class="small muted" style="margin:0">Repère : 2 h pour un studio, 3 h pour un 2 pièces, 4 h pour un 3 pièces.</p>
             <label class="check"><input type="checkbox" id="kit" ${draft.kit ? 'checked' : ''}> Je n'ai pas de matériel : l'intervenante apporte aspirateur et produits (+15 €)</label>`}
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
        <fieldset class="box"><legend>Heure d'arrivée</legend><div id="slots"><p class="muted small">Recherche des créneaux libres…</p></div><div id="prefNote"></div></fieldset>
        ${draft.date === todayParis() ? `<label class="check"><input type="checkbox" id="urgent" ${draft.urgent ? 'checked' : ''}> Urgence : arrivée dans les 3 prochaines heures (+25 %)</label>` : ''}
        <fieldset class="box"><legend>Fréquence</legend>
          <div class="chips">${[['0', 'Une seule fois'], ['7', 'Chaque semaine'], ['14', 'Toutes les 2 semaines']].map(([v, l]) => `<button type="button" data-repeat="${v}" aria-pressed="${draft.repeat === v}">${l}</button>`).join('')}</div>
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
      if (/^\d{5}$/.test(draft.cp)) {
        r = await api('GET', `/api/slots?date=${encodeURIComponent(draft.date)}&cp=${encodeURIComponent(draft.cp)}&hours=${draftHours(draft)}${draft.home_id ? `&home_id=${draft.home_id}` : ''}`);
        if (draft.time && !r.slots.includes(draft.time)) draft.time = null;
        const paintSlots = () => {
          const p = r.preferred;
          box.innerHTML = r.slots.length
            ? `<div class="chips times">${r.slots.map((t) => `<button type="button" data-time="${t}" aria-pressed="${draft.time === t}">${t}${p && p.slots.includes(t) ? ' ★' : ''}</button>`).join('')}</div>
               ${p ? `<p class="small muted" style="margin:6px 0 0">★ ${esc(p.name)}, votre intervenante préférée, est libre à ces heures-là.</p>` : ''}`
            : '<p class="msg warn">Aucune intervenante n\'est libre ce jour-là. Essayez une autre date.</p>';
          pref.innerHTML = p && draft.time && !p.slots.includes(draft.time) ? `<p class="notice"><b>${esc(p.name)} n'est pas libre à ${esc(draft.time)}.</b> Une autre intervenante vérifiée viendra.${p.slots.length ? ` Choisissez une heure marquée ★ pour l'avoir.` : ` Elle n'est pas libre ce jour-là.`}</p>` : '';
          box.querySelectorAll('[data-time]').forEach((b) => b.onclick = () => { draft.time = b.dataset.time; paintSlots(); });
        };
        paintSlots();
      } else box.innerHTML = '<p class="msg">Entrez le code postal pour voir les heures libres.</p>';
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
        const s = await api('GET', `/api/slots?date=${draft.date}&cp=${draft.cp}&hours=${draftHours(draft)}${draft.home_id ? `&home_id=${draft.home_id}` : ''}`);
        if (s.preferred && s.preferred.slots.includes(draft.time)) who = `${s.preferred.name}, votre intervenante préférée`;
      } catch { /* sans incidence */ }
      shell(`
        <h1>Récapitulatif</h1>
        <dl class="facts">
          <div><dt>Prestation</dt><dd>${draft.service === 'airbnb' ? `Ménage Airbnb ${SIZE[draft.size]} (ménage + linge)` : `${SERVICE[draft.service]} ${String(draft.hours).replace('.', ',')} h`}${draft.kit ? ', matériel fourni' : ''} <button class="link" data-goto="1">Modifier</button></dd></div>
          <div><dt>Date</dt><dd>${esc(dateLong(draft.date))} à ${esc(draft.time)}${n > 1 ? `, puis ${draft.repeat === '7' ? 'chaque semaine' : 'toutes les 2 semaines'} (${n} ménages)` : ''} <button class="link" data-goto="2">Modifier</button></dd></div>
          <div><dt>Adresse</dt><dd>${esc(draft.address)}, ${esc(draft.cp)}</dd></div>
          <div><dt>Intervenante</dt><dd>${esc(who)}</dd></div>
          <div><dt>À faire</dt><dd>${draft.tasks.length} tâches${draft.photoConsent ? ', photos avant / après' : ''}</dd></div>
        </dl>
        ${q.ok ? `<div class="price">
          <div class="row"><span>Total TTC${n > 1 ? ' du premier ménage' : ''}</span><span class="total">${eur(q.total)}</span></div>
          ${q.lines.map((l) => `<div class="line"><span>${esc(l.label)}</span><span>${eur(l.amount)}</span></div>`).join('')}
          ${q.service !== 'airbnb' ? `<div class="line"><span>Après crédit d'impôt de 50 %*</span><span>${eur(q.total / 2)}</span></div>` : ''}
        </div>
        ${n > 1 ? '<p class="small muted">Chaque ménage est facturé à son prix (supplément le dimanche ou un jour férié).</p>' : ''}
        ${q.service !== 'airbnb' ? '<p class="small muted">* Selon les conditions en vigueur, une fois l\'entreprise déclarée « services à la personne ».</p>' : ''}` : `<p class="err">${q.errors.map(esc).join(' ')}</p>`}
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
          <p class="notice" style="margin:0"><b>Version de test :</b> le paiement est simulé. Aucune carte n'est demandée ni débitée.</p>
        </div>
        <label class="check"><input type="checkbox" id="cgv" ${draft.cgv ? 'checked' : ''}> J'accepte les <a href="#/cgv" target="_blank" rel="noopener">conditions générales de vente</a> et la <a href="#/confidentialite" target="_blank" rel="noopener">politique de confidentialité</a>.</label>
        <p class="err" id="err4"></p>
        <div class="nav2"><button class="btn ghost" id="back">Retour</button><button class="btn primary" id="pay">Payer ${eur(q.total)}</button></div>`, 4);
      document.getElementById('cgv').onchange = (e) => { draft.cgv = e.target.checked; };
      document.getElementById('back').onclick = () => { draft.step = 3; render(); };
      document.getElementById('pay').onclick = async (e) => {
        if (!draft.cgv) { document.getElementById('err4').textContent = 'Merci d\'accepter les conditions générales.'; return; }
        e.target.disabled = true;
        try {
          const r = await api('POST', '/api/bookings', { ...draft, urgent: !!draft.urgent, kit: !!draft.kit, checklist: draft.tasks, home_id: draft.home_id || undefined });
          $app.innerHTML = `<section class="card wizard done-card">
            <p class="big-check" aria-hidden="true">✓</p>
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
        <p class="small">Pas encore de compte ? <a href="#/inscription">Créer un compte client</a> · <a href="#/inscription-intervenante">Devenir intervenante</a></p>
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

  function signup(role) {
    const worker = role === 'intervenante';
    $app.innerHTML = `
      <section class="card stack" style="max-width:520px;margin:auto">
        <h1>${worker ? 'Devenir intervenante' : 'Créer un compte'}</h1>
        ${worker ? '<p class="muted">Après votre inscription, notre équipe vous contacte pour la suite : vérification de l\'identité, entretien, formation. Vous recevrez des missions une fois votre compte activé.</p>' : ''}
        <form id="f" class="stack">
          <label>Prénom et nom<input type="text" name="name" autocomplete="name" required></label>
          <label>E-mail<input type="email" name="email" autocomplete="email" required></label>
          <label>Téléphone<input type="tel" name="phone" autocomplete="tel"></label>
          <label>Mot de passe (10 caractères minimum)<input type="password" name="password" autocomplete="new-password" minlength="10" required></label>
          ${worker ? `
            <label>Code postal de votre domicile<input type="text" name="cp" inputmode="numeric" maxlength="5" required></label>
            <label>Vous souhaitez travailler comme
              <select name="statut" id="statut"><option value="S">Salariée de Proprigo</option><option value="I">Indépendante (auto-entrepreneuse)</option></select></label>
            <label id="rateBox" hidden>Votre tarif horaire, facturé à Proprigo<input type="number" name="rate" min="15" max="40" step="0.5" value="24"></label>` : ''}
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
        await loadMe();
        go(worker ? '#/intervenante' : (sessionStorage.getItem('after') || '#/reserver'));
        sessionStorage.removeItem('after');
      } catch (err) { toast(err.message); }
    };
  }
  views['inscription'] = () => signup('client');
  views['inscription-intervenante'] = () => signup('intervenante');

  const REPEAT = { 7: 'Chaque semaine', 14: 'Toutes les 2 semaines' };
  views['mes-reservations'] = async () => {
    if (!me || me.role !== 'client') return go('#/connexion');
    const list = await api('GET', '/api/bookings/mine');
    const mw = await api('GET', '/api/my-workers');
    const series = {};
    const hoursLeft = (b) => (Date.parse(`${b.date}T${b.time}:00`) - Date.now()) / 36e5;
    $app.innerHTML = `
      <div class="row"><h1>Mes réservations</h1><a class="btn primary" href="#/reserver">Nouvelle réservation</a></div>
      <p class="small muted">${FREE_CANCEL}</p>
      ${list.length ? '' : '<p class="card muted">Aucune réservation pour le moment.</p>'}
      ${list.map((b) => {
        const active = ['en_attente', 'proposee', 'attribuee'].includes(b.status);
        const showStop = b.series_id && active && !series[b.series_id];
        if (b.series_id) series[b.series_id] = true;
        return `
        <article class="card">
          <div class="row"><h3>${esc(label(b))}${b.series_id ? ' <span class="pill">Récurrent</span>' : ''}</h3>${pill(b.status)}</div>
          <p class="muted" style="margin:6px 0 0">${dateFr(b.date)} à ${esc(b.time)} · ${esc(b.address)} · ${esc(b.cp)} · <b>${eur(b.total)}</b>${b.kit ? ' · matériel fourni' : ''}</p>
          ${b.worker_name ? `<p style="margin:8px 0 0">Intervenante vérifiée : <b>${esc(b.worker_name)}</b>${mw.favorite === b.worker_id ? ' <span class="pill ok">★ Votre préférée</span>' : ''}</p>` : ''}
          ${b.source === 'ical' ? '<p class="small muted" style="margin:6px 0 0">Créé automatiquement depuis le calendrier de votre annonce.</p>' : ''}
          ${b.ical_flagged && ['en_attente', 'proposee', 'attribuee'].includes(b.status) ? `<div class="notice"><b>Ce séjour n'apparaît plus dans le calendrier de votre annonce.</b> Le ménage reste prévu. Si le séjour est bien annulé, annulez le ménage ; sinon, gardez-le.<div class="actions"><button class="btn ghost" data-keep="${b.id}">Garder le ménage</button><button class="btn ghost" data-cancel="${b.id}">Annuler le ménage</button></div></div>` : ''}
          <p class="small muted" style="margin:6px 0 0">${PAY[b.payment_status] || ''}</p>
          ${b.status === 'terminee' && b.worker_id && mw.favorite !== b.worker_id ? `<p style="margin:8px 0 0"><button class="btn ghost" data-fav="${b.worker_id}">★ Garder ${esc(b.worker_name.split(' ')[0])} pour mes prochains ménages</button></p>` : ''}
          ${b.checklist.length ? `<details><summary>Ce qui doit être fait (${b.checklist.filter((t) => t.done).length}/${b.checklist.length} fait)</summary><ul class="tasks">${b.checklist.map((t) => `<li class="${t.done ? 'done' : ''}">${t.done ? '✓' : '○'} ${esc(t.task)}</li>`).join('')}</ul></details>` : ''}
          ${b.photos.length ? `<div class="photos">${b.photos.map((p) => `<figure><img src="/api/photos/${p.id}" alt="Photo ${p.kind === 'avant' ? 'avant' : 'après'} le ménage" loading="lazy"><figcaption>${p.kind === 'avant' ? 'Avant' : 'Après'}</figcaption></figure>`).join('')}</div>` : ''}
          <div class="row" style="justify-content:flex-start;margin-top:10px">
            ${active && hoursLeft(b) >= 24 ? `<button class="btn ghost" data-edit="${b.id}">Modifier</button>` : ''}
            ${active ? `<button class="btn ghost" data-cancel="${b.id}">${hoursLeft(b) >= 24 ? 'Annuler' : 'Annuler (50 % retenus)'}</button>` : ''}
            ${b.status === 'terminee' ? `<a class="btn ghost" href="/api/bookings/${b.id}/receipt" target="_blank" rel="noopener">Reçu</a>` : ''}
            ${showStop ? `<button class="btn ghost" data-stop="${b.series_id}">Arrêter la récurrence</button>` : ''}
            ${b.status !== 'annulee' ? `<button class="btn ghost" data-thread="${b.id}">Messages${b.messages ? ` (${b.messages})` : ''}</button>` : ''}
            ${['en_cours', 'terminee'].includes(b.status) ? `<button class="btn ghost" data-report="${b.id}">Signaler un problème</button>` : ''}
          </div>
          ${active && hoursLeft(b) < 24 ? '<p class="small muted">Moins de 24 h avant le ménage : pour un changement, écrivez-nous dans les messages.</p>' : ''}
          ${active && b.preferred_id && b.worker_id !== b.preferred_id ? `<div class="notice"><b>${esc(b.preferred_name)}, votre intervenante préférée, n'est pas disponible à ce créneau.</b> Une autre intervenante vérifiée Proprigo viendra à sa place.
            ${hoursLeft(b) >= 24 ? `<br>Vous préférez ${esc(b.preferred_name)} ? <button class="btn ghost" data-prefslots="${b.id}">Voir quand ${esc(b.preferred_name)} est libre</button><div id="pref-${b.id}"></div>` : ''}</div>` : ''}
          <div id="edit-${b.id}"></div><div id="report-${b.id}"></div><div id="thread-${b.id}"></div>
          ${b.status === 'terminee' && !b.rating ? `<p style="margin:10px 0 0"><b>Comment s'est passé le ménage ?</b></p><div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-rate="${b.id}" data-stars="${n}" aria-label="${n} sur 5">★</button>`).join('')}</div>` : ''}
          ${b.rating ? `<p class="small muted" style="margin:8px 0 0">Votre note : ${'★'.repeat(b.rating)}</p>` : ''}
        </article>`;
      }).join('')}`;
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
    act('[data-fav]', async (btn) => { try { const r = await api('POST', '/api/favorite', { worker_id: Number(btn.dataset.fav) }); toast(r.message); route(); } catch (e) { toast(e.message); } });
    $app.querySelectorAll('[data-keep]').forEach((btn) => btn.onclick = async () => { try { const r = await api('POST', `/api/bookings/${btn.dataset.keep}/ical-keep`, {}); toast(r.message); route(); } catch (e) { toast(e.message); } });
    act('[data-cancel]', async (btn) => { try { const r = await api('POST', `/api/bookings/${btn.dataset.cancel}/cancel`, {}); toast(r.message || 'Réservation annulée.'); route(); } catch (e) { toast(e.message); } });
    act('[data-stop]', async (btn) => { try { const r = await api('POST', `/api/series/${btn.dataset.stop}/stop`, {}); toast(r.message); route(); } catch (e) { toast(e.message); } });
    act('[data-rate]', async (btn) => { try { await api('POST', `/api/bookings/${btn.dataset.rate}/rate`, { stars: Number(btn.dataset.stars) }); toast('Merci pour votre avis.'); route(); } catch (e) { toast(e.message); } });
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
        <label>Type de ménage<select name="service">${['airbnb', 'menage', 'grand'].map((k) => `<option value="${k}" ${service === k ? 'selected' : ''}>${SERVICE[k]}</option>`).join('')}</select></label>
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
  views['intervenante'] = async () => {
    if (!me || me.role !== 'intervenante') return go('#/connexion');
    const r = await api('GET', '/api/worker/missions');
    const p = r.profile;
    const isI = p.statut === 'I';
    const head = `<div class="row"><h1>Bonjour ${esc(p.name.split(' ')[0])}</h1><span class="pill">${isI ? 'Indépendante' : 'Salariée'} · ${esc(p.cp)}</span></div>`;
    const cal = {};
    for (const a of r.availability) cal[a.weekday] = a;
    const calendar = `
      <section class="card stack"><h2>Mes disponibilités</h2>
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
      </section>
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
        </section>${calendar}`;
      bindCalendar();
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
          ${b.instructions ? `<div class="box"><b>Consignes du logement</b><p style="margin:4px 0 0;white-space:pre-line">${esc(b.instructions)}</p></div>` : ''}
          ${b.kit ? '<p><span class="pill warn">Apporter le kit matériel et produits</span></p>' : ''}
          ${b.checklist.length ? `<fieldset class="box"><legend>À faire</legend>${b.checklist.map((t, i) => `<label class="check"><input type="checkbox" data-check="${b.id}" data-index="${i}" ${t.done ? 'checked' : ''}> ${esc(t.task)}</label>`).join('')}</fieldset>` : ''}
          ${b.photo_consent ? `<div class="box stack"><b>Photos avant / après</b>
            ${b.photos.length ? `<div class="photos">${b.photos.map((ph) => `<figure><img src="/api/photos/${ph.id}" alt="Photo ${ph.kind}" loading="lazy"><figcaption>${ph.kind === 'avant' ? 'Avant' : 'Après'}</figcaption></figure>`).join('')}</div>` : ''}
            ${b.status === 'en_cours' ? `<div class="row" style="justify-content:flex-start"><label class="btn ghost">Photo avant<input type="file" accept="image/*" capture="environment" data-photo="${b.id}" data-kind="avant" hidden></label>
              <label class="btn ghost">Photo après<input type="file" accept="image/*" capture="environment" data-photo="${b.id}" data-kind="apres" hidden></label></div>
              <p class="small muted">Au moins une photo « après » est demandée pour terminer.</p>` : '<p class="small muted">Le client a accepté les photos : vous pourrez les prendre une fois le ménage commencé.</p>'}
          </div>` : '<p class="small muted">Pas de photos pour ce ménage (le client ne l\'a pas demandé).</p>'}
          <div class="row" style="justify-content:flex-start">${act(b)}<button class="btn ghost" data-thread="${b.id}">Messages${b.messages ? ` (${b.messages})` : ''}</button></div>
          <div id="thread-${b.id}"></div>
        </article>`;
    const act = (b) => b.status === 'attribuee'
      ? `<button class="btn primary full" data-act="start" data-id="${b.id}">Commencer le ménage</button>`
      : `<button class="btn primary full" data-act="finish" data-id="${b.id}">Terminer la mission</button>`;
    $app.innerHTML = `${head}
      ${p.absent ? '<p class="card"><span class="pill warn">Absente</span> Vos missions sont confiées à d\'autres intervenantes.</p>' : ''}
      <p class="muted">${isI ? `Vous choisissez vos missions et pouvez refuser sans pénalité. Votre tarif : ${eur(p.rate)}/h.` : 'Vos missions sont attribuées par le planning Proprigo.'}</p>
      ${isI ? `<h2 style="margin-top:20px">Propositions</h2>${r.offers.length ? r.offers.map((b) => `
        <article class="card">
          <div class="row"><h3>${esc(label(b))}</h3><span class="pill">${eur(b.earn)}</span></div>
          <p class="muted" style="margin:6px 0 0">${dateFr(b.date)} à ${esc(b.time)} · ${esc(b.cp)} · ${String(b.hours).replace('.', ',')} h${b.kit ? ' · apporter le kit matériel' : ''}</p>
          <p class="small muted">L'adresse exacte s'affiche après acceptation.</p>
          <div class="row" style="justify-content:flex-start"><button class="btn ghost" data-act="refuse" data-id="${b.id}">Refuser</button><button class="btn primary" data-act="accept" data-id="${b.id}">Accepter</button></div>
        </article>`).join('') : '<p class="card muted">Aucune proposition pour le moment.</p>'}` : ''}
      ${today.length ? `<h2 style="margin-top:20px">Aujourd'hui</h2>${today.map(card).join('')}` : '<p class="card muted" style="margin-top:20px">Pas de mission aujourd\'hui.</p>'}
      ${later.length ? `<h2 style="margin-top:20px">À venir</h2>${(() => { const one = (b) => `<details class="card later"><summary><b>${dateFr(b.date)} ${esc(b.time)}</b> · ${esc(label(b))} · ${esc(b.cp)} ${pill(b.status)}</summary>${card(b)}</details>`; return later.slice(0, 5).map(one).join('') + (later.length > 5 ? `<details class="more"><summary>Voir les ${later.length - 5} autres missions</summary>${later.slice(5).map(one).join('')}</details>` : ''); })()}` : ''}
      <section class="card"><h3>${isI ? 'Facturé' : 'Heures effectuées'}</h3>
        <p style="margin:6px 0 0"><b style="font-family:Outfit;font-size:30px">${isI ? eur(r.done.h * p.rate) : String(r.done.h).replace('.', ',') + ' h'}</b></p>
        <p class="small muted">${r.done.n} mission${r.done.n > 1 ? 's' : ''} terminée${r.done.n > 1 ? 's' : ''}</p></section>
      ${calendar}`;
    $app.querySelectorAll('[data-act]').forEach((btn) => btn.onclick = async () => {
      try { await api('POST', `/api/worker/missions/${btn.dataset.id}/${btn.dataset.act}`, {}); toast('C\'est enregistré.'); route(); } catch (e) { toast(e.message); }
    });
    $app.querySelectorAll('[data-check]').forEach((c) => c.onchange = async () => {
      try { await api('POST', `/api/worker/missions/${c.dataset.check}/checklist`, { index: Number(c.dataset.index), done: c.checked }); } catch (e) { toast(e.message); c.checked = !c.checked; }
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

  views['admin'] = async () => {
    if (!me || me.role !== 'admin') return go('#/connexion');
    const r = await api('GET', '/api/admin/overview');
    const k = r.kpis;
    const ob = await api('GET', '/api/admin/outbox').catch(() => ({ list: [] }));
    const bk = await api('GET', '/api/admin/backups').catch(() => ({ enabled: false, list: [] }));
    const in3 = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    const todo = [
      ...r.bookings.filter((b) => ['en_attente', 'proposee'].includes(b.status) && b.date <= in3).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
        .map((b) => `<li class="${b.status === 'en_attente' ? 'urgent' : ''}"><span><b>${b.status === 'en_attente' ? 'Sans intervenante' : 'En attente d\'acceptation'}</b> · réservation n° ${b.id}, ${dateFr(b.date)} ${esc(b.time)}, ${esc(b.cp)}</span><button class="btn ghost" data-goto-bk="${b.id}">Choisir l'intervenante</button><div id="todo-pick-${b.id}" style="flex-basis:100%"></div></li>`),
      ...(r.icalFlagged || []).map((x) => `<li class="urgent"><span><b>Séjour disparu du calendrier</b> · ménage n° ${x.id}${x.home_name ? ` (${esc(x.home_name)})` : ''}, ${dateFr(x.date)} ${esc(x.time)}. Vérifiez avec le client.</span><span class="row" style="gap:6px;flex-wrap:wrap"><button class="btn ghost" data-ikeep="${x.id}">Garder</button><button class="btn ghost" data-icancel="${x.id}">Annuler et rembourser</button></span></li>`),
      ...r.incidents.map((x) => `<li class="urgent"><span><b>Réclamation</b> · réservation n° ${x.booking_id} : ${esc(x.text.slice(0, 80))}${x.text.length > 80 ? '…' : ''}</span><button class="btn ghost" data-goto="incidents">Voir</button></li>`),
      ...r.workers.filter((w) => w.absent).map((w) => `<li><span><b>Absente</b> · ${esc(w.name)}</span><button class="btn ghost" data-absent="${w.user_id}">Marquer présente</button></li>`),
      ...(k.aRembourser.n ? [`<li><span><b>Remboursements</b> · ${k.aRembourser.n} réservation(s), ${eur(k.aRembourser.montant)}</span><button class="btn ghost" data-goto="table">Voir</button></li>`] : []),
      ...(r.workers.some((w) => !w.active) ? [`<li><span><b>Candidatures</b> · ${r.workers.filter((w) => !w.active).length} intervenante(s) en cours de recrutement</span><button class="btn ghost" data-goto="team">Voir</button></li>`] : []),
    ];
    $app.innerHTML = `
      <h1>Tableau de bord</h1>
      ${r.paymentsEnabled ? '' : '<p class="card"><span class="pill warn">Paiement simulé</span> Aucun argent n\'est encaissé dans cette version. Le chiffre d\'affaires affiché est théorique.</p>'}
      <nav class="tabs" role="tablist" aria-label="Administration">${[['todo', `À traiter${todo.length ? ` (${todo.length})` : ''}`], ['resa', 'Réservations'], ['equipe', 'Équipe'], ['chiffres', 'Chiffres'], ['suivi', 'Suivi']].map(([k, t]) => `<button type="button" role="tab" data-tab-btn="${k}">${t}</button>`).join('')}</nav>
      <section class="card todo" data-tab="todo"><h2>À traiter maintenant</h2>${todo.length ? `<ul class="plain">${todo.join('')}</ul>` : '<p class="msg ok">Rien d\'urgent : toutes les missions des 3 prochains jours ont une intervenante.</p>'}</section>
      <div class="kpis" data-tab="chiffres">
        <div class="kpi"><span class="small muted">Réservations</span><b>${k.reservations}</b><span class="small muted">${k.terminees} terminées</span></div>
        <div class="kpi"><span class="small muted">Chiffre d'affaires HT</span><b>${eur(k.caHT)}</b><span class="small muted">missions terminées</span></div>
        <div class="kpi"><span class="small muted">Marge estimée</span><b>${eur(k.marge)}</b><span class="small muted">${k.caHT ? Math.round((k.marge / k.caHT) * 100) : 0} % du CA</span></div>
        <div class="kpi"><span class="small muted">À rembourser</span><b>${eur(k.aRembourser.montant)}</b><span class="small muted">${k.aRembourser.n} réservation${k.aRembourser.n > 1 ? 's' : ''} annulée${k.aRembourser.n > 1 ? 's' : ''}</span></div>
        <div class="kpi"><span class="small muted">Note moyenne</span><b>${k.noteMoyenne ? String(k.noteMoyenne).replace('.', ',') + ' / 5' : '–'}</b><span class="small muted">${k.clients} client${k.clients > 1 ? 's' : ''}</span></div>
      </div>
      <section class="card" id="sec-table" data-tab="resa"><h2>Réservations</h2><div class="scroll"><table class="bk">
        <thead><tr><th>N°</th><th>Prestation</th><th>Date</th><th>Code postal</th><th>Intervenante</th><th>État</th><th class="n">Prix TTC</th><th>Paiement</th><th></th></tr></thead>
        <tbody>${r.bookings.map((b) => `<tr class="bkrow"><td data-l="N°"><b>n° ${b.id}</b></td><td data-l="Prestation">${esc(label(b))}${b.kit ? ' <span class="pill">matériel</span>' : ''}</td><td data-l="Date">${dateFr(b.date)} ${esc(b.time)}</td><td data-l="Code postal">${esc(b.cp)}</td>
          <td data-l="Intervenante">${b.worker_name ? esc(b.worker_name) : '<span class="muted">–</span>'}</td><td data-l="État">${pill(b.status)}${b.rating ? ' ' + '★'.repeat(b.rating) : ''}</td><td class="n" data-l="Prix TTC">${eur(b.total)}</td><td class="small" data-l="Paiement">${PAY[b.payment_status] || ''}</td>
          <td class="acts">${['en_attente', 'proposee', 'attribuee'].includes(b.status) ? `<button class="btn ghost" data-pick="${b.id}">Choisir l'intervenante</button>` : ''}${b.payment_status === 'a_rembourser' ? `<button class="btn ghost" data-refund="${b.id}">Marquer remboursé</button>` : ''}<button class="btn ghost" data-thread="${b.id}">Messages${b.messages ? ` (${b.messages})` : ''}</button></td></tr><tr class="threadrow"><td colspan="9" style="padding:0;border:0"><div id="thread-${b.id}"></div></td></tr>`).join('') || '<tr><td colspan="9" class="muted">Aucune réservation.</td></tr>'}</tbody>
      </table></div></section>
      ${r.incidents.length ? `<section class="card" id="sec-incidents" data-tab="todo"><h2>Problèmes signalés par les clients</h2>${r.incidents.map((x) => `
        <div class="row box" style="margin-top:8px"><div><b>Réservation n° ${x.booking_id}</b> · ${dateFr(x.date)} ${esc(x.time)} · ${esc(x.cp)}<br>${esc(x.text)}</div>
        <div class="row"><button class="btn ghost" data-thread="${x.booking_id}" data-inc>Écrire au client</button><button class="btn blue" data-resolve="${x.id}">Marquer traité</button></div></div>
        <div id="thread-inc-${x.booking_id}"></div>`).join('')}</section>` : ''}
      <section class="card" id="sec-team" data-tab="equipe"><h2>Équipe et recrutement</h2>
        <p class="small muted">Aucune mission avant le statut « Active ».</p>
        <div class="grid2" style="gap:12px">${r.workers.map((w) => `
          <div class="card" style="margin:0">
            <div class="row"><b>${esc(w.name)}</b><span class="pill">${w.statut === 'S' ? 'Salariée' : 'Indépendante'}</span></div>
            <span class="small muted">${esc(w.cp)}${w.rate ? ' · ' + eur(w.rate) + '/h' : ''} · ${esc(w.email)}</span>
            <div class="prog"><i style="width:${(w.step / (w.steps.length - 1)) * 100}%"></i></div>
            <div class="row"><span class="small">${w.active ? (w.absent ? '<span class="pill warn">Absente</span>' : '<span class="pill ok">Active</span>') : 'À valider : ' + esc(w.steps[w.step + 1])}</span>
            ${w.active ? `<button class="btn ghost" data-absent="${w.user_id}">${w.absent ? 'Marquer présente' : 'Marquer absente'}</button>` : `<button class="btn ghost" data-advance="${w.user_id}">Valider l'étape</button>`}</div>
          </div>`).join('')}</div></section>
      <div class="panes">
        <section class="card" data-tab="chiffres"><h2>Liste d'attente</h2><p class="small muted">Demandes hors zone ouverte, par département.</p>
          <div class="chips">${r.waitlist.map((x) => `<span class="pill">${esc(x.dept)} · ${x.n}</span>`).join('') || '<span class="muted">Aucune demande.</span>'}</div></section>
        <section class="card" data-tab="suivi"><h2>E-mails envoyés</h2><p class="small muted">${ob.provider ? `Envoi réel via ${esc(ob.provider)}.` : 'Mode local : les e-mails ne partent pas, ils sont enregistrés ici pour vérification.'}</p>
          <ul class="plain small">${ob.list.slice(0, 12).map((m) => `<li><span>${esc(m.subject)}<br><span class="muted">${esc(m.to)}</span></span><a href="/api/admin/outbox/${encodeURIComponent(m.file)}" target="_blank" rel="noopener">Ouvrir</a></li>`).join('') || '<li class="muted">Aucun e-mail.</li>'}</ul></section>
        <section class="card" data-tab="suivi"><h2>Sauvegardes</h2>
          ${bk.enabled ? `<p class="small muted">Une sauvegarde automatique par jour ; les 14 dernières sont gardées dans <b>data/backups</b>. Copiez-les aussi ailleurs (clé USB, stockage en ligne).</p>
          ${bk.error ? `<p class="msg warn">Dernière sauvegarde en échec : ${esc(bk.error)}</p>` : ''}
          <ul class="plain small">${bk.list.map((x) => `<li><span>${new Date(x.time).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' })}</span><span class="muted">${Math.max(1, Math.round(x.size / 1024))} Ko</span></li>`).join('') || '<li class="muted">Aucune sauvegarde pour le moment.</li>'}</ul>
          <button class="btn ghost" id="doBackup">Sauvegarder maintenant</button>` : '<p class="small muted">Sauvegardes désactivées.</p>'}</section>
        <section class="card" data-tab="chiffres"><h2>Hypothèses de marge</h2><p class="small muted">La marge est une estimation. Ces valeurs sont dans le fichier <b>config/couts.json</b> : faites-les valider par votre expert-comptable puis modifiez-les si besoin (redémarrage nécessaire).</p>
          <ul class="small"><li>Coût d'une salariée par heure facturée : ${eur(r.couts.salarieeParHeureFacturee)}</li><li>TVA particuliers : ${Math.round(r.couts.tvaParticulier * 100)} % · professionnels : ${Math.round(r.couts.tvaPro * 100)} %</li><li>Produits par mission : ${eur(r.couts.produits)} · matériel fourni : ${eur(r.couts.kitCout)}</li></ul></section>
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
    bind('data-advance', (id) => `/api/admin/workers/${id}/advance`);
    bind('data-absent', (id) => `/api/admin/workers/${id}/absent`);
    bind('data-refund', (id) => `/api/admin/bookings/${id}/refunded`);
    bind('data-resolve', (id) => `/api/admin/incidents/${id}/resolve`);
    const showTab = (k) => {
      sessionStorage.setItem('adminTab', k);
      $app.querySelectorAll('[data-tab]').forEach((el) => { el.hidden = el.dataset.tab !== k; });
      $app.querySelectorAll('[data-tab-btn]').forEach((t) => t.setAttribute('aria-selected', t.dataset.tabBtn === k));
    };
    $app.querySelectorAll('[data-tab-btn]').forEach((t) => t.onclick = () => { showTab(t.dataset.tabBtn); window.scrollTo(0, 0); });
    showTab(sessionStorage.getItem('adminTab') || 'todo');
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
    // Liste de choix directe : intervenantes libres, de la plus proche à la plus éloignée.
    async function showPicker(id, host) {
      let c;
      try { c = await api('GET', `/api/admin/bookings/${id}/candidates`); } catch (e) { return toast(e.message); }
      const opts = c.list.map((w) => `<option value="${w.user_id}">${esc(w.name)} · ${w.statut === 'S' ? 'salariée' : 'indépendante'} · ${esc(w.cp)} · ${esc(w.proximite)}${w.offered ? ' · déjà proposée' : ''}${w.refused ? ' · a refusé' : ''}</option>`).join('');
      host.innerHTML = `<div class="pick">
        <label>Intervenantes libres à cette heure-là, de la plus proche à la plus éloignée
          <select id="pick-${id}">${opts}<option value="auto">Choix automatique</option></select></label>
        ${c.list.length ? '' : '<p class="small muted">Aucune autre intervenante n\'est libre à cette heure-là.</p>'}
        <p class="small muted">Une salariée reçoit la mission directement. Une indépendante la reçoit en proposition et peut refuser.</p>
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
  views['compte'] = () => {
    if (!me) return go('#/connexion');
    $app.innerHTML = `
      <h1>Mon compte</h1>
      <div class="grid2">
        <section class="card stack">
          <h2>Mes informations</h2>
          <form id="info" class="stack">
            <label>Nom<input type="text" name="name" autocomplete="name" maxlength="80" value="${esc(me.name)}" required></label>
            <label>Téléphone<input type="tel" name="phone" autocomplete="tel" maxlength="20" value="${esc(me.phone || '')}"></label>
            <label>E-mail<input type="email" value="${esc(me.email)}" disabled></label>
            <p class="small muted" style="margin:0">Pour changer d'e-mail, écrivez à l'équipe Proprigo.</p>
            <button class="btn blue">Enregistrer</button>
          </form>
        </section>
        <section class="card stack">
          <h2>Mot de passe</h2>
          <form id="pw" class="stack">
            <label>Mot de passe actuel<input type="password" name="current" autocomplete="current-password" required></label>
            <label>Nouveau mot de passe (10 caractères minimum)<input type="password" name="password" autocomplete="new-password" minlength="10" required></label>
            <button class="btn blue">Changer le mot de passe</button>
          </form>
        </section>
      </div>
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
        </details>` : `<p class="small muted">${me.role === 'admin' ? 'Compte administrateur : choisissez un mot de passe long et unique avant de partager le site.' : "Pour fermer votre compte intervenante, écrivez à l'équipe Proprigo : certains documents liés à votre activité doivent être conservés."}</p>`}
      </section>`;
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
  };

  // ---------- pages d'information (textes à faire valider par un avocat) ----------
  const DRAFT_NOTE = '<p class="notice">Projet de texte, à faire relire par un avocat avant l\'ouverture. Les passages entre crochets sont à compléter.</p>';
  const page = (title, body) => { $app.innerHTML = `<article class="card legal"><h1>${title}</h1>${body}</article>`; };

  views['aide'] = () => {
    const faq = [
      ['Comment réserver ?', 'Cliquez sur « Réserver », choisissez le type de ménage, puis la date et l\'heure parmi les créneaux réellement libres. Vous voyez le prix total avant de payer.'],
      ['Puis-je annuler ?', "Oui, depuis « Mes réservations ». L'annulation est gratuite jusqu'à 24 h avant le ménage. Moins de 24 h avant, 50 % du prix est retenu, car l'intervenante a réservé ce créneau pour vous."],
      ['Puis-je changer la date ou l\'heure ?', 'Oui, avec « Modifier », jusqu\'à 24 h avant. Le prix est recalculé (par exemple un dimanche) et nous vérifions qu\'une intervenante est libre. Moins de 24 h avant, écrivez-nous dans la messagerie de la réservation.'],
      ['Qui vient chez moi ?', "Une intervenante sélectionnée et vérifiée par Proprigo (identité, entretien, formation). Vous voyez son prénom avant le ménage. Après un ménage, vous pouvez la garder comme intervenante préférée."],
      ['Et si elle est absente ?', 'Nous cherchons automatiquement une remplaçante vérifiée et vous prévenons par e-mail et dans la messagerie. Si vous préférez garder votre intervenante, vous pouvez choisir un autre créneau où elle est libre.'],
      ['Faut-il fournir le matériel ?', "Pour un ménage à domicile, vous pouvez fournir aspirateur et produits, ou choisir l'option « matériel fourni » (+15 €). Pour un logement Airbnb, le matériel reste dans le logement."],
      ['Les photos sont-elles obligatoires ?', "Non. Les photos avant / après ne sont prises que si vous l'acceptez. Seuls vous et l'équipe Proprigo pouvez les voir, et elles sont supprimées après 90 jours."],
      ['Comment payer ?', "Par carte, au moment de la réservation. Version de test : le paiement est simulé, rien n'est débité. Le reçu est disponible dans « Mes réservations » une fois le ménage terminé."],
      ['Le ménage ne me convient pas, que faire ?', 'Dans « Mes réservations », cliquez sur « Signaler un problème » sous le ménage concerné. Notre équipe qualité vous répond rapidement et vous propose une solution (repassage, geste commercial selon le cas).'],
    ];
    page('Aide et réclamations', `
      <p class="lead">Les réponses aux questions les plus fréquentes. Pour un ménage précis, le plus rapide est la messagerie de la réservation.</p>
      ${faq.map(([q, a]) => `<details class="faq"><summary>${q}</summary><p>${a}</p></details>`).join('')}
      <h2>Faire une réclamation</h2>
      <ol><li>Ouvrez <a href="#/mes-reservations">Mes réservations</a>.</li><li>Sous le ménage concerné, cliquez sur « Signaler un problème » et décrivez la situation, avec une photo si possible.</li><li>Notre équipe vous répond dans la messagerie de la réservation, et par e-mail.</li></ol>
      <p>Si la réponse ne vous satisfait pas, vous pouvez saisir gratuitement le médiateur de la consommation : [NOM ET SITE DU MÉDIATEUR].</p>
      <h2>Nous contacter</h2><p>E-mail : [ADRESSE E-MAIL DU SERVICE CLIENT] · Téléphone : [NUMÉRO] (du lundi au samedi, 9 h à 19 h)</p>`);
  };

  views['intervenantes-verifiees'] = () => page('Nos intervenantes', `
    <p class="lead">Une intervenante ne reçoit aucune mission avant d'avoir passé toutes les étapes de sélection.</p>
    <ol class="check-list"><li><b>Vérification de l'identité</b> et de l'autorisation de travailler en France.</li><li><b>Vérification du statut</b> : contrat de travail Proprigo, ou numéro SIRET et attestation URSSAF pour une indépendante.</li><li><b>Entretien</b> avec notre équipe.</li><li><b>Vérification de l'expérience</b>.</li><li><b>Formation</b> aux standards de ménage Proprigo (salariées).</li><li><b>Première mission accompagnée</b>.</li><li><b>Suivi de la qualité</b> : chaque note inférieure à 4 sur 5 est traitée par l'équipe.</li></ol>
    <h2>Assurance</h2><p>Les prestations sont couvertes par une assurance responsabilité civile professionnelle : [NOM DE L'ASSUREUR, NUMÉRO DE CONTRAT]. Une assurance ne couvre pas automatiquement tous les incidents ; les conditions sont détaillées dans les <a href="#/cgv">conditions générales</a>.</p>
    <h2>Remplacement garanti</h2><p>En cas d'absence de votre intervenante, nous cherchons automatiquement une remplaçante vérifiée et vous prévenons. Vous pouvez aussi choisir un autre créneau pour la garder.</p>`);

  views['cgv'] = () => page('Conditions générales de vente', `${DRAFT_NOTE}
    <h2>1. Objet</h2><p>Les présentes conditions encadrent les prestations de ménage réservées sur Proprigo par des particuliers et des professionnels (hôtes et conciergeries), exploité par [RAISON SOCIALE], [FORME JURIDIQUE] au capital de [MONTANT], immatriculée sous le numéro [SIREN], siège : [ADRESSE].</p>
    <h2>2. Prestations</h2><p>Ménage à domicile à l'heure, grand nettoyage, ménage de logement de location courte durée au forfait (ménage et linge). Les tâches prévues figurent dans la checklist de la réservation. Les prestations sont réalisées par des intervenantes salariées de Proprigo ou des intervenantes indépendantes sélectionnées.</p>
    <h2>3. Prix</h2><p>Les prix sont indiqués en euros toutes taxes comprises avant la réservation. Suppléments : dimanche et jours fériés +20 %, intervention urgente (arrivée dans les 3 heures) +25 %, matériel et produits fournis +15 €. [Le crédit d'impôt de 50 % s'applique aux services à la personne selon les conditions légales, une fois la déclaration de l'entreprise effectuée.]</p>
    <h2>4. Réservation et paiement</h2><p>La réservation est ferme après paiement en ligne par carte bancaire via [PRESTATAIRE DE PAIEMENT]. Une confirmation est envoyée par e-mail. Le client s'engage à donner une adresse exacte et l'accès au logement à l'heure prévue.</p>
    <h2>5. Modification et annulation</h2><p>La date, l'heure, la durée et l'adresse peuvent être modifiées jusqu'à 24 heures avant le début de la prestation, sous réserve de disponibilité ; le prix est recalculé. L'annulation est gratuite jusqu'à 24 heures avant ; ensuite, 50 % du prix reste dû. Si l'intervenante ne peut pas accéder au logement du fait du client, la prestation est due.</p>
    <h2>6. Droit de rétractation</h2><p>Pour une réservation faite à distance par un consommateur, le droit de rétractation de 14 jours s'applique. Si le client demande que la prestation commence avant la fin de ce délai, il le reconnaît expressément et reste redevable du montant correspondant au service fourni. [Rédaction à valider.]</p>
    <h2>7. Remplacement de l'intervenante</h2><p>En cas d'indisponibilité de l'intervenante prévue, Proprigo peut la remplacer par une autre intervenante vérifiée et en informe le client, qui peut choisir un autre créneau.</p>
    <h2>8. Qualité et réclamations</h2><p>Toute réclamation doit être faite dans les [48] heures suivant la prestation depuis « Signaler un problème ». Proprigo propose une solution adaptée (nouveau passage, geste commercial).</p>
    <h2>9. Responsabilité et assurance</h2><p>Proprigo est assuré en responsabilité civile professionnelle auprès de [ASSUREUR]. Le client signale les objets fragiles ou de valeur. [Limites et exclusions à préciser avec l'assureur, notamment pour les vols.]</p>
    <h2>10. Photos et données personnelles</h2><p>Voir la <a href="#/confidentialite">politique de confidentialité</a>.</p>
    <h2>11. Médiation et droit applicable</h2><p>En cas de litige, le consommateur peut recourir gratuitement au médiateur : [NOM, ADRESSE, SITE]. Droit français.</p>`);

  views['mentions-legales'] = () => page('Mentions légales', `${DRAFT_NOTE}
    <p><b>Éditeur</b> : [RAISON SOCIALE], [FORME JURIDIQUE] au capital de [MONTANT], RCS [VILLE ET NUMÉRO], siège : [ADRESSE]. TVA intracommunautaire : [NUMÉRO].</p>
    <p><b>Directeur de la publication</b> : [NOM].</p>
    <p><b>Contact</b> : [ADRESSE E-MAIL], [TÉLÉPHONE].</p>
    <p><b>Hébergeur</b> : [NOM, ADRESSE ET TÉLÉPHONE DE L'HÉBERGEUR].</p>
    <p><b>Déclaration services à la personne</b> : [NUMÉRO DE DÉCLARATION NOVA, une fois obtenu].</p>
    <p><b>Propriété intellectuelle</b> : la marque Proprigo, le logo et les contenus du site sont la propriété de [RAISON SOCIALE]. [Numéro de dépôt INPI.]</p>`);

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
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  async function route() {
    renderNav();
    const [name, qs] = location.hash.replace(/^#\/?/, '').split('?');
    const view = views[name] || views[''];
    try { await view(new URLSearchParams(qs || '')); } catch (e) { $app.innerHTML = `<p class="card err">${esc(e.message)}</p>`; }
    $app.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', route);
  loadMe().catch(() => {}).finally(route);
})();
