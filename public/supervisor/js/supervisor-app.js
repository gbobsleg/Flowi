'use strict';

const SUPERVISOR_TAB_IDS = new Set(['live', 'history', 'grid', 'directory', 'settings', 'about']);
const SETTINGS_SUBTAB_IDS = new Set(['general', 'offers', 'planning', 'access']);
const LEGACY_TAB_REDIRECTS = { quotas: 'live', planning: 'grid' };
const PLANNING_IMPORT_WEEKDAY_OPTIONS = [
  { value: 1, label: 'lun' },
  { value: 2, label: 'mar' },
  { value: 3, label: 'mer' },
  { value: 4, label: 'jeu' },
  { value: 5, label: 'ven' },
  { value: 6, label: 'sam' },
  { value: 7, label: 'dim' },
];

function parseSupervisorHash(hash) {
  const raw = String(hash || '').replace(/^#/, '').trim();
  const parts = raw.split('/').filter(Boolean);
  const seg0 = parts[0] || '';
  const seg1 = parts[1] || '';

  if (!seg0) {
    return { tab: 'live', settingsSubtab: 'general', canonical: 'live', rewrite: true };
  }
  if (LEGACY_TAB_REDIRECTS[seg0]) {
    const tab = LEGACY_TAB_REDIRECTS[seg0];
    return { tab, settingsSubtab: 'general', canonical: tab, rewrite: true };
  }
  if (!SUPERVISOR_TAB_IDS.has(seg0)) {
    return { tab: 'live', settingsSubtab: 'general', canonical: 'live', rewrite: true };
  }
  if (seg0 === 'settings') {
    const sub = SETTINGS_SUBTAB_IDS.has(seg1) ? seg1 : 'general';
    const canonical = `settings/${sub}`;
    return {
      tab: 'settings',
      settingsSubtab: sub,
      canonical,
      rewrite: raw !== canonical,
    };
  }
  return {
    tab: seg0,
    settingsSubtab: 'general',
    canonical: seg0,
    rewrite: parts.length > 1,
  };
}

function supervisorLocationBase() {
  return window.location.pathname + (window.location.search || '');
}

function parisClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const g = (type) => parts.find((p) => p.type === type).value;
  const hour = Number(g('hour'));
  const minute = Number(g('minute'));
  return {
    day: `${g('year')}-${g('month')}-${g('day')}`,
    hour,
    minute,
    slotMinutes: hour * 60 + Math.floor(minute / 15) * 15,
  };
}

function formatSlotMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseHmClient(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

const PLANNING_HOURS_KEY = 'flowi.planningGridHours';
const PLANNING_HOURS_DEFAULT = { from: '09:00', to: '17:00' };

function loadStoredPlanningHours() {
  try {
    const raw = localStorage.getItem(PLANNING_HOURS_KEY);
    if (!raw) return { ...PLANNING_HOURS_DEFAULT };
    const parsed = JSON.parse(raw);
    const from = parseHmClient(parsed.from);
    const to = parseHmClient(parsed.to);
    if (from == null || to == null || !(from < to)) return { ...PLANNING_HOURS_DEFAULT };
    return { from: formatSlotMinutes(from), to: formatSlotMinutes(to) };
  } catch {
    return { ...PLANNING_HOURS_DEFAULT };
  }
}

function initialRouteFromHash() {
  if (typeof window === 'undefined') {
    return { tab: 'live', settingsSubtab: 'general' };
  }
  return parseSupervisorHash(window.location.hash);
}

function supervisorApp() {
  return {
    // ── Auth ─────────────────────────────────────
    isAuth:       false,
    pinInput:     '',
    loginError:   '',
    loginLoading: false,

    // ── Navigation ───────────────────────────────
    activeTab: initialRouteFromHash().tab,
    settingsSubtab: initialRouteFromHash().settingsSubtab,
    liveOverridesOpen: false,
    _supervisorTabRoutingBound: false,
    tabs: [
      { id: 'live',      label: 'Temps réel' },
      { id: 'history',   label: 'Historique' },
      { id: 'grid',      label: 'Grille' },
      { id: 'directory', label: 'Annuaire' },
      { id: 'settings',  label: 'Paramètres' },
      { id: 'about',     label: 'À propos' },
    ],
    settingsTabs: [
      { id: 'general',  label: 'Général' },
      { id: 'offers',   label: 'Offres' },
      { id: 'planning', label: 'Planning' },
      { id: 'access',   label: 'Accès' },
    ],

    // ── Socket ───────────────────────────────────
    socketConnected: false,
    _socket: null,

    // ── Quotas ───────────────────────────────────
    quotas: [],  // augmentés de _edit, _saving, _saveError, currentHeadcount

    // ── Planning ─────────────────────────────────
    planningDay: parisClock().day,
    planningImporting: false,
    planningApplying: false,
    planningImportError: '',
    planningImportHint: '',
    planningImportResult: null,
    planningImportApplied: false,
    planningImportFile: null,
    planningMappings: [],
    planningMappingSaving: false,
    planningMappingError: '',
    planningMappingMsg: '',
    planningSlots: [],
    planningSlotsError: '',
    planningPreviewByDay: {},
    planningPreviewDay: '',
    planningImportWeekdays: [1, 2, 3, 4, 5],
    planningSkipFrenchHolidays: true,
    planningImportDaysError: '',
    planningImportDaysMsg: '',
    _planningImportDaysMsgTimer: null,
    planningImportWeekdayOptions: PLANNING_IMPORT_WEEKDAY_OPTIONS,
    planningGridFrom: loadStoredPlanningHours().from,
    planningGridTo: loadStoredPlanningHours().to,
    planningGridHoursError: '',
    pauseWindows: [],
    pauseWindowDraft: { start: '', end: '' },
    pauseWindowsSaving: false,
    pauseWindowsError: '',
    pauseWindowsMsg: '',

    // ── Live ─────────────────────────────────────
    livePauses: [], // { id, agent_matricule, nom, prenom, agentName, offerCode, startTime, _forcing }
    _tick: null,
    _now: Date.now(),
    thresholdRed:    14,
    thresholdOrange: 12,

    updateThresholds() {
      const m = this.settings?.maxPauseMinutes ?? 15;
      this.thresholdRed    = Math.max(1, m - 1);
      this.thresholdOrange = Math.max(1, m - 3);
    },

    // ── Historique ───────────────────────────────
    histRows:       [],
    histLoading:    false,
    histPagination: { page: 1, limit: 50, total: 0, pages: 0 },
    histFilter:     { offerCode: '', from: '', to: '' },
    histOffers:     [],
    histSort:       { key: 'start_time', dir: 'desc' },
    histCols: [
      { key: 'agent_name',  label: 'Agent' },
      { key: 'offer_label',  label: 'Offre' },
      { key: 'start_date',  label: 'Date' },
      { key: 'start_time',  label: 'Heure début' },
      { key: 'end_time',    label: 'Heure fin' },
      { key: 'duration_seconds', label: 'Durée' },
      { key: 'end_reason',  label: 'Motif' },
    ],

    // ── Annuaire ────────────────────────────────
    directoryRows: [],
    directoryLoading: false,
    directoryLoaded: false,
    directoryCreditsAt: Date.now(),
    directorySaving: false,
    directoryError: '',
    directoryMsg: '',
    directoryForm: { matricule: '', nom: '', prenom: '' },

    // ── À propos ─────────────────────────────────
    aboutRows: [],
    aboutLoading: false,
    aboutLoaded: false,
    aboutError: '',

    // ── Offres (admin) ────────────────────────────
    offersAdminRows: [],
    showInactiveOffers: false,
    offersAdminLoading: false,
    offerForm: {
      mode: 'create',
      originalCode: '',
      code: '',
      label: '',
      default_quota: 2,
      allowed_percent: 20,
      color: '#000000',
      useDefaultColor: true,
    },
    offerSaving: false,
    offerError: '',
    offerMsg: '',
    offerMsgOk: true,
    offerPercentRetry: null,
    offerPercentRetrying: false,
    /** `null` | `'__new__'` | code offre — un seul panneau ouvert */
    expandedOfferCode: null,

    get histSorted() {
      const rows = [...this.histRows];
      const { key, dir } = this.histSort;
      rows.sort((a, b) => {
        const valueForSort = (row, sortKey) => {
          if (sortKey === 'start_date') return row.start_time ?? '';
          return row[sortKey] ?? '';
        };
        const va = valueForSort(a, key);
        const vb = valueForSort(b, key);
        if (va < vb) return dir === 'asc' ? -1 :  1;
        if (va > vb) return dir === 'asc' ?  1 : -1;
        return 0;
      });
      return rows;
    },

    get mappingOfferOptions() {
      if (this.histOffers.length) return this.histOffers;
      return this.quotas.map((q) => q.offer).filter(Boolean);
    },

    get visibleOffersAdminRows() {
      const rows = this.offersAdminRows || [];
      if (this.showInactiveOffers) return rows;
      return rows.filter((o) => o.is_active === true);
    },

    get visibleLiveQuotas() {
      return (this.quotas || []).filter((q) => {
        if (q.offer?.is_active !== false) return true;
        return Number(q.currentPaused) > 0;
      });
    },

    mapOffersToGridRows(offers) {
      return (offers || [])
        .filter((offer) => this.planningOfferActive(offer) || (offer.slots || []).length > 0)
        .map((offer) => {
          const bySlot = {};
          for (const s of offer.slots || []) bySlot[s.slotMinutes] = s;
          return { ...offer, bySlot };
        });
    },

    get planningGridRows() {
      return this.mapOffersToGridRows(this.planningSlots);
    },

    get planningPreviewDays() {
      return Object.keys(this.planningPreviewByDay || {}).sort();
    },

    get planningPreviewGridRows() {
      return this.mapOffersToGridRows(this.planningPreviewByDay[this.planningPreviewDay] || []);
    },

    get canRerunPlanningPreview() {
      return !!this.planningFileToSend()
        && !this.planningImportResult
        && !this.planningImporting
        && !this.planningApplying;
    },

    get planningSlotColumns() {
      const from = parseHmClient(this.planningGridFrom);
      const to = parseHmClient(this.planningGridTo);
      const start = from == null ? 9 * 60 : Math.floor(from / 15) * 15;
      const end = to == null ? 17 * 60 : (to % 15 === 0 ? to : Math.ceil(to / 15) * 15);
      if (!(start < end)) {
        return this.buildPlanningSlotColumns(9 * 60, 17 * 60);
      }
      return this.buildPlanningSlotColumns(start, end);
    },

    // ── Mode urgence (maintenance) ───────────────
    maintenanceMode:    false,
    maintenanceLoading: false,

    // ── OTA ──────────────────────────────────────
    otaChecking:     false,
    otaCheckResult:  null,
    otaCheckError:   '',
    otaRunning:      false,
    otaLaunchError:  '',
    otaLogs:         [],

    // ── Paramètres ───────────────────────────────
    settings:       { historyRetentionDays: 30, maxPauseMinutes: 15, maxPausesPerAgent: '', anonymizeAgentNames: false, github_owner: '', github_repo: '' },
    githubTokenConfigured: false,
    githubTokenInput:      '',
    githubOtaSaving:       false,
    githubOtaMsg:          '',
    githubOtaMsgOk:        true,
    supervisorPinConfigured: false,
    supervisorPinInput:      '',
    supervisorPinSaving:     false,
    supervisorPinMsg:        '',
    supervisorPinMsgOk:      true,
    settingsSaving: false,
    settingsMsg:    '',
    settingsMsgOk:  true,
    maxPauseSaving: false,
    maxPauseMsg:    '',
    maxPauseMsgOk:  true,
    maxPausesSaving: false,
    maxPausesMsg:    '',
    maxPausesMsgOk:  true,
    anonymizeSaving: false,
    anonymizeMsg:    '',
    anonymizeMsgOk:  true,

    // ── Init ─────────────────────────────────────
    async init() {
      await this.checkAuth();
      if (!this.isAuth) return;
      // Aligner l’URL (hash) et activeTab AVANT $watch(immediate), sinon chargements lazy ignorés ou en course d’écrasement.
      this.syncSupervisorTabFromUrl();
      this.ensureSupervisorTabRouting();
      await this.loadAll();
      // Après stabilisation réseau (quotas/auth) : re-fetch annuaire si onglet actif,
      // sinon le 1er load (watch + directoryLoaded) peut rester vide en race / cache navigateur (ex. Firefox F5).
      if (this.activeTab === 'directory') await this.loadDirectory(true);
      if (this.activeTab === 'settings') await this.loadSettingsSubtabData(this.settingsSubtab);
      if (this.activeTab === 'grid') await this.loadPlanningSlots();
      if (this.activeTab === 'about') await this.loadAbout(true);
      this.connectSocket();
      this.startTick();
    },

    async checkAuth() {
      try {
        const res = await fetch('/api/supervisor/quotas', {
          credentials: 'include',
          cache: 'no-store',
        });
        if (res.status === 200) this.isAuth = true;
      } catch { /* non authentifié */ }
    },

    async loadAll() {
      await Promise.all([
        this.loadQuotas(),
        this.loadHistory(1),
        this.loadSettings(),
        this.loadMaintenanceMode(),
      ]);
    },

    ensureSupervisorTabRouting() {
      if (this._supervisorTabRoutingBound) return;
      this._supervisorTabRoutingBound = true;
      window.addEventListener('hashchange', () => this.applyHashChangeToActiveTab());

      this.$watch('activeTab', async (value) => {
        if (!this.isAuth) return;
        if (value === 'directory') await this.loadDirectory(true);
        else if (value === 'settings') await this.loadSettingsSubtabData(this.settingsSubtab);
        else if (value === 'grid') await this.loadPlanningSlots();
        else if (value === 'about') await this.loadAbout();
      }, { immediate: true });

      this.$watch('settingsSubtab', async (value) => {
        if (!this.isAuth || this.activeTab !== 'settings') return;
        await this.loadSettingsSubtabData(value);
      });
    },

    applyParsedSupervisorRoute(parsed) {
      if (parsed.rewrite) {
        window.history.replaceState(null, '', `${supervisorLocationBase()}#${parsed.canonical}`);
      }
      if (parsed.tab === 'settings') this.settingsSubtab = parsed.settingsSubtab;
      if (this.activeTab !== parsed.tab) this.activeTab = parsed.tab;
    },

    /** Met à jour activeTab / settingsSubtab depuis location.hash ; charge async délégué au $watch(activeTab). */
    applyHashChangeToActiveTab() {
      if (!this.isAuth) return;
      this.applyParsedSupervisorRoute(parseSupervisorHash(window.location.hash));
    },

    /** Au premier affichage authentifié : hash vide/invalide/legacy → replaceState ; sinon état = hash. */
    syncSupervisorTabFromUrl() {
      this.applyParsedSupervisorRoute(parseSupervisorHash(window.location.hash));
    },

    /** Clic onglet : navigation native (historique) ; activeTab mis à jour via hashchange. */
    navigateToTab(tabId) {
      if (!SUPERVISOR_TAB_IDS.has(tabId)) return;
      if (tabId === 'settings') {
        const sub = SETTINGS_SUBTAB_IDS.has(this.settingsSubtab) ? this.settingsSubtab : 'general';
        window.location.hash = `#settings/${sub}`;
        return;
      }
      window.location.hash = `#${tabId}`;
    },

    navigateToSettingsSubtab(sub) {
      const next = SETTINGS_SUBTAB_IDS.has(sub) ? sub : 'general';
      window.location.hash = `#settings/${next}`;
    },

    async loadSettingsSubtabData(sub) {
      if (sub === 'offers') {
        await Promise.all([this.loadOffersAdmin(), this.loadQuotas()]);
      } else if (sub === 'planning') {
        await Promise.all([this.loadPlanning(), this.loadSettings()]);
      }
    },

    // ── Auth ─────────────────────────────────────
    async login() {
      if (!this.pinInput || this.loginLoading) return;
      this.loginLoading = true;
      this.loginError   = '';
      try {
        const res  = await fetch('/api/supervisor/auth', {
          method:      'POST',
          headers:     { 'Content-Type': 'application/json' },
          credentials: 'include',
          body:        JSON.stringify({ pin: this.pinInput }),
        });
        if (res.ok) {
          this.isAuth    = true;
          this.pinInput  = '';
          this.syncSupervisorTabFromUrl();
          this.ensureSupervisorTabRouting();
          await this.loadAll();
          if (this.activeTab === 'directory') await this.loadDirectory(true);
          if (this.activeTab === 'settings') await this.loadSettingsSubtabData(this.settingsSubtab);
          if (this.activeTab === 'grid') await this.loadPlanningSlots();
          if (this.activeTab === 'about') await this.loadAbout(true);
          this.connectSocket();
          this.startTick();
        } else {
          const d = await res.json();
          this.loginError = d.error?.message || 'Code PIN incorrect.';
        }
      } catch { this.loginError = 'Erreur réseau.'; }
      finally   { this.loginLoading = false; }
    },

    async logout() {
      try {
        await fetch('/api/supervisor/logout', { method: 'POST', credentials: 'include' });
      } catch { /* ignore */ }
      this.isAuth = false;
      this.pinInput = '';
      if (this._socket) { this._socket.disconnect(); this._socket = null; }
      if (this._tick)   { clearInterval(this._tick); this._tick = null; }
    },

    // ── Quotas ───────────────────────────────────
    hasQuotaOverride(q) {
      const v = q?.rule?.fixedQuota;
      return v !== null && v !== undefined && v !== '';
    },

    liveOverrideSummary() {
      const rows = this.visibleLiveQuotas;
      const blocked = rows.filter((q) => q.blocked).length;
      const overrides = rows.filter((q) => this.hasQuotaOverride(q)).length;
      return `${blocked} offres bloquées / ${overrides} quotas forcés`;
    },

    async loadQuotas() {
      try {
        const clock = parisClock();
        const [res, slotsRes] = await Promise.all([
          fetch('/api/supervisor/quotas', {
            credentials: 'include',
            cache: 'no-store',
          }),
          fetch(`/api/supervisor/planning/slots?day=${encodeURIComponent(clock.day)}`, {
            credentials: 'include',
            cache: 'no-store',
          }),
        ]);
        const data = await res.json();
        const slotsData = slotsRes.ok ? await slotsRes.json() : { offers: [] };
        const slotByCode = new Map();
        for (const offer of slotsData.offers || []) {
          const cur = (offer.slots || []).find((s) => s.slotMinutes === clock.slotMinutes);
          slotByCode.set(offer.offerCode, cur || null);
        }
        this.quotas = (data.quotas || []).map(q => {
          const slot = slotByCode.get(q.offer.code);
          return {
            ...q,
            currentHeadcount: slot ? slot.headcount : null,
            currentAllowed: slot ? slot.allowed : null,
            _edit: {
              fixedQuota:     q.rule.fixedQuota    ?? '',
              allowedPercent: q.rule.allowedPercent ?? '',
            },
            _saving:   false,
            _saveError: '',
          };
        });
        this.histOffers = this.quotas.map(q => q.offer);
      } catch { /* silencieux */ }
    },

    async refreshCurrentSlotStats() {
      try {
        const clock = parisClock();
        const res = await fetch(`/api/supervisor/planning/slots?day=${encodeURIComponent(clock.day)}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = await res.json();
        for (const offer of data.offers || []) {
          const q = this.quotas.find((x) => x.offer.code === offer.offerCode);
          if (!q) continue;
          const cur = (offer.slots || []).find((s) => s.slotMinutes === clock.slotMinutes);
          q.currentHeadcount = cur ? cur.headcount : null;
          q.currentAllowed = cur ? cur.allowed : null;
        }
      } catch { /* silencieux */ }
    },

    async saveQuota(q) {
      q._saving   = true;
      q._saveError = '';

      const n = parseInt(q._edit.fixedQuota, 10);
      const body = {
        fixedQuota: Number.isInteger(n) ? n : null,
      };

      try {
        const res  = await fetch(`/api/supervisor/quotas/${q.offer.code}`, {
          method:      'PUT',
          headers:     { 'Content-Type': 'application/json' },
          credentials: 'include',
          body:        JSON.stringify(body),
        });
        const data = await res.json();
        if (res.ok) {
          q.effectiveQuota = data.effectiveQuota;
          q.currentPaused  = data.currentPaused;
          q.blocked        = data.blocked;
          q.rule.fixedQuota = body.fixedQuota;
          await this.refreshCurrentSlotStats();
        } else {
          q._saveError = data.error?.message || 'Erreur lors de la sauvegarde.';
        }
      } catch { q._saveError = 'Erreur réseau.'; }
      finally  { q._saving = false; }
    },

    // ── Planning ─────────────────────────────────
    mappingOfferLabel(offer) {
      const name = offer?.label || offer?.code || '';
      return offer?.is_active === false ? `${name} (désactivée)` : name;
    },

    planningOfferActive(offer) {
      if (!offer) return false;
      if (typeof offer.isActive === 'boolean') return offer.isActive;
      if (typeof offer.is_active === 'boolean') return offer.is_active;
      const q = (this.quotas || []).find((x) => x.offer?.code === offer.offerCode);
      if (q) return q.offer.is_active !== false;
      return true;
    },

    mappingStatusLabel(row) {
      if (row.offerCode === '__ignore__') return 'Ignoré';
      if (row.offerCode) return 'Associé';
      return 'Non classé';
    },

    mappingSortRank(row) {
      if (row.offerCode && row.offerCode !== '__ignore__') return 0;
      if (row.offerCode === '__ignore__') return 2;
      return 1;
    },

    mappingStatusClass(row) {
      if (row.offerCode === '__ignore__') return 'bg-slate-100 text-slate-600';
      if (row.offerCode) return 'bg-brand-500/15 text-brand-700';
      return 'bg-amber-50 text-amber-700';
    },

    formatPlanningDay(isoDay) {
      const m = String(isoDay || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return isoDay || '—';
      return `${m[3]}/${m[2]}/${m[1]}`;
    },

    planningPeriodLabel() {
      const days = this.planningImportResult?.days || [];
      if (!days.length) return '—';
      if (days.length === 1) return this.formatPlanningDay(days[0]);
      return `${this.formatPlanningDay(days[0])} → ${this.formatPlanningDay(days[days.length - 1])}`;
    },

    planningReplaceSummary() {
      const days = this.planningImportResult?.days || [];
      if (!days.length) return '';
      if (days.length === 1) {
        return `1 jour sera remplacé : ${this.formatPlanningDay(days[0])}.`;
      }
      return `${days.length} jours seront remplacés, du ${this.formatPlanningDay(days[0])} au ${this.formatPlanningDay(days[days.length - 1])}.`;
    },

    planningAppliedSummary() {
      const days = this.planningImportResult?.days || [];
      if (!days.length) return 'Planning remplacé.';
      if (days.length === 1) {
        return `Planning remplacé : 1 jour (${this.formatPlanningDay(days[0])}).`;
      }
      return `Planning remplacé : ${days.length} jours, du ${this.formatPlanningDay(days[0])} au ${this.formatPlanningDay(days[days.length - 1])}.`;
    },

    isCurrentPlanningSlot(minutes) {
      const clock = parisClock();
      return this.planningDay === clock.day && minutes === clock.slotMinutes;
    },

    planningCellClass(row, minutes) {
      if (!this.isCurrentPlanningSlot(minutes)) return '';
      return this.planningOfferActive(row) ? 'bg-slate-50' : 'bg-slate-100';
    },

    planningQuotaRule(row) {
      if (row.fixedQuota != null) {
        return `Quota forcé ${row.fixedQuota} — écrase le calcul de la grille`;
      }
      if (row.allowedPercent != null) {
        return `${row.allowedPercent} % des planifiés (min. 1 si effectif > 0)`;
      }
      return `Quota défaut ${row.defaultQuota} (% non renseigné)`;
    },

    buildPlanningSlotColumns(start, end) {
      const cols = [];
      for (let minutes = start; minutes < end && minutes < 1440; minutes += 15) {
        cols.push({ minutes, label: formatSlotMinutes(minutes) });
      }
      return cols;
    },

    applyPlanningHours() {
      const from = parseHmClient(this.planningGridFrom);
      const to = parseHmClient(this.planningGridTo);
      if (from == null || to == null) {
        this.planningGridHoursError = 'Horaires HH:MM invalides.';
        return;
      }
      const start = Math.floor(from / 15) * 15;
      const end = to % 15 === 0 ? to : Math.ceil(to / 15) * 15;
      if (!(start < end)) {
        this.planningGridHoursError = 'L’heure de fin doit être après le début.';
        return;
      }
      this.planningGridHoursError = '';
      this.planningGridFrom = formatSlotMinutes(start);
      this.planningGridTo = formatSlotMinutes(end);
      try {
        localStorage.setItem(PLANNING_HOURS_KEY, JSON.stringify({
          from: this.planningGridFrom,
          to: this.planningGridTo,
        }));
      } catch { /* ignore quota / mode privé */ }
      this.$nextTick(() => this.scrollPlanningGrid());
    },

    scrollPlanningGrid() {
      const table = document.querySelector('.planning-grid');
      if (!table) return;
      const cols = this.planningSlotColumns;
      if (!cols.length) return;
      const clock = parisClock();
      let minutes = cols[0].minutes;
      if (this.planningDay === clock.day) {
        const current = cols.find((c) => c.minutes === clock.slotMinutes);
        if (current) minutes = current.minutes;
      } else {
        const occupied = [];
        for (const offer of this.planningSlots || []) {
          for (const slot of offer.slots || []) {
            if (cols.some((c) => c.minutes === slot.slotMinutes)) occupied.push(slot.slotMinutes);
          }
        }
        if (occupied.length) minutes = Math.min(...occupied);
      }
      const th = table.querySelector(`thead th[data-minutes="${minutes}"]`);
      if (th) th.scrollIntoView({ inline: 'start', block: 'nearest' });
    },

    mergePlanningMappings(apiRows, extraUnmapped = []) {
      this._ignoreMappingChange = true;
      const byLabel = new Map();
      for (const row of apiRows || []) {
        let offerCode = '';
        if (row.offerCode) offerCode = row.offerCode;
        else if (row.ignored) offerCode = '__ignore__';
        else if (row.offerId == null && row.unmapped !== true) offerCode = '__ignore__';
        byLabel.set(row.label, { label: row.label, offerCode });
      }
      for (const label of extraUnmapped || []) {
        if (!byLabel.has(label)) byLabel.set(label, { label, offerCode: '' });
      }
      this.planningMappings = [...byLabel.values()].sort((a, b) => {
        const rank = this.mappingSortRank(a) - this.mappingSortRank(b);
        if (rank !== 0) return rank;
        return a.label.localeCompare(b.label, 'fr');
      });
      this.$nextTick(() => { this._ignoreMappingChange = false; });
    },

    async loadPlanning() {
      await Promise.all([this.loadPlanningMapping(), this.loadPlanningSlots()]);
    },

    async loadPlanningMapping() {
      try {
        const res = await fetch('/api/supervisor/planning/mapping', {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = await res.json();
        this.mergePlanningMappings(data.mappings || [], this.planningImportResult?.unmapped || []);
      } catch { /* silencieux */ }
    },

    async loadPlanningSlots() {
      this.planningSlotsError = '';
      const day = this.planningDay || parisClock().day;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        this.planningSlotsError = 'Date invalide.';
        return;
      }
      try {
        const res = await fetch(`/api/supervisor/planning/slots?day=${encodeURIComponent(day)}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        const data = await res.json();
        if (!res.ok) {
          this.planningSlotsError = data.error?.message || 'Impossible de charger la grille.';
          return;
        }
        this.planningSlots = data.offers || [];
        this.$nextTick(() => this.scrollPlanningGrid());
      } catch {
        this.planningSlotsError = 'Erreur réseau.';
      }
    },

    clearPlanningPreview(hint = '') {
      this.planningImportResult = null;
      this.planningImportApplied = false;
      this.planningImportError = '';
      this.planningImportHint = hint;
      this.planningPreviewByDay = {};
      this.planningPreviewDay = '';
    },

    onPlanningFileChange() {
      const input = this.$refs.planningFile;
      const file = input && input.files && input.files[0];
      this.planningImportFile = file || null;
      if (!file) return;
      if (this.planningImportResult || this.planningImportApplied) {
        this.clearPlanningPreview();
      }
      this.previewPlanning();
    },

    resetPlanningFileInput() {
      this.planningImportFile = null;
      const input = this.$refs.planningFile;
      if (input) input.value = '';
    },

    onPlanningMappingChange() {
      if (this._ignoreMappingChange) return;
      if (!this.planningImportResult || this.planningImportApplied) return;
      this.clearPlanningPreview(
        'Correspondance modifiée : enregistrez-la si besoin, puis relancez l’analyse.'
      );
    },

    planningFileToSend() {
      if (this.planningImportFile) return this.planningImportFile;
      const input = this.$refs.planningFile;
      return (input && input.files && input.files[0]) || null;
    },

    async previewPlanning() {
      const file = this.planningFileToSend();
      if (!file) {
        this.planningImportError = 'Choisissez un fichier CSV.';
        return;
      }
      this.planningImporting = true;
      this.planningImportError = '';
      this.planningImportHint = '';
      this.planningImportApplied = false;
      try {
        const body = new FormData();
        body.append('file', file);
        const res = await fetch('/api/supervisor/planning/import/preview', {
          method: 'POST',
          credentials: 'include',
          body,
        });
        const data = await res.json();
        if (!res.ok) {
          this.planningImportError = data.error?.message || 'Analyse refusée.';
          this.planningImportResult = null;
          this.planningPreviewByDay = {};
          this.planningPreviewDay = '';
          return;
        }
        this.planningImportFile = file;
        this.planningImportResult = data;
        this.planningPreviewByDay = data.offersByDay || {};
        this.$nextTick(() => {
          const previewDays = Object.keys(this.planningPreviewByDay).sort();
          const withStaff = previewDays.find((d) =>
            (this.planningPreviewByDay[d] || []).some((o) => (o.slots || []).length > 0)
          );
          this.planningPreviewDay = withStaff || previewDays[0] || '';
        });
        this.mergePlanningMappings(
          this.planningMappings.map((r) => ({
            label: r.label,
            offerCode: r.offerCode || null,
            ignored: r.offerCode === '__ignore__',
            unmapped: !r.offerCode,
          })),
          data.unmapped || []
        );
      } catch {
        this.planningImportError = 'Erreur réseau.';
        this.planningImportResult = null;
        this.planningPreviewByDay = {};
        this.planningPreviewDay = '';
      } finally {
        this.planningImporting = false;
      }
    },

    async applyPlanningImport() {
      if (!this.planningImportResult || this.planningImportApplied) return;
      const file = this.planningFileToSend();
      if (!file) {
        this.planningImportError = 'Choisissez un fichier CSV.';
        return;
      }
      this.planningApplying = true;
      this.planningImportError = '';
      try {
        const body = new FormData();
        body.append('file', file);
        const res = await fetch('/api/supervisor/planning/import', {
          method: 'POST',
          credentials: 'include',
          body,
        });
        const data = await res.json();
        if (!res.ok) {
          this.planningImportError = data.error?.message || 'Remplacement refusé.';
          return;
        }
        this.planningImportResult = data;
        this.planningImportApplied = true;
        this.resetPlanningFileInput();
        const days = data.days || [];
        if (days.length) this.planningDay = days[0];
        await Promise.all([this.loadPlanningMapping(), this.loadPlanningSlots(), this.loadQuotas()]);
      } catch {
        this.planningImportError = 'Erreur réseau.';
      } finally {
        this.planningApplying = false;
      }
    },

    cancelPlanningPreview() {
      this.clearPlanningPreview();
    },

    openPlanningGrid() {
      const days = this.planningImportResult?.days || [];
      if (days.length) this.planningDay = days[0];
      this.navigateToTab('grid');
    },

    async savePlanningMapping() {
      const mappings = this.planningMappings
        .filter((row) => row.offerCode !== '')
        .map((row) => ({
          label: row.label,
          offerCode: row.offerCode === '__ignore__' ? null : row.offerCode,
        }));
      if (!mappings.length) {
        this.planningMappingError = 'Classez au moins un libellé (offre ou Ignorer).';
        return;
      }
      this.planningMappingSaving = true;
      this.planningMappingError = '';
      this.planningMappingMsg = '';
      try {
        const res = await fetch('/api/supervisor/planning/mapping', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ mappings }),
        });
        const data = await res.json();
        if (!res.ok) {
          this.planningMappingError = data.error?.message || 'Enregistrement refusé.';
          return;
        }
        if (!this.planningImportApplied) {
          this.clearPlanningPreview(
            'Correspondance modifiée : enregistrez-la si besoin, puis relancez l’analyse.'
          );
        }
        this.mergePlanningMappings(data.mappings || [], []);
        this.planningMappingMsg = 'Correspondance enregistrée, grille recalculée.';
        await Promise.all([this.loadPlanningSlots(), this.loadQuotas()]);
        setTimeout(() => { this.planningMappingMsg = ''; }, 4000);
      } catch {
        this.planningMappingError = 'Erreur réseau.';
      } finally {
        this.planningMappingSaving = false;
      }
    },

    async addPauseWindow() {
      this.pauseWindowsError = '';
      const startRaw = String(this.pauseWindowDraft.start || '').trim();
      const endRaw = String(this.pauseWindowDraft.end || '').trim();
      if (!startRaw || !endRaw) {
        this.pauseWindowsError = 'Saisissez un début et une fin.';
        return;
      }
      const start = parseHmClient(startRaw);
      const end = parseHmClient(endRaw);
      if (start == null || end == null) {
        this.pauseWindowsError = 'Horaires HH:MM invalides.';
        return;
      }
      if (!(start < end)) {
        this.pauseWindowsError = 'Le début doit précéder la fin.';
        return;
      }
      const startLabel = formatSlotMinutes(start);
      const endLabel = formatSlotMinutes(end);
      this.pauseWindows = [...this.pauseWindows, { start: startLabel, end: endLabel }];
      this.pauseWindowDraft = { start: '', end: '' };
      await this.savePauseWindows();
    },

    async removePauseWindow(idx) {
      this.pauseWindows = this.pauseWindows.filter((_, i) => i !== idx);
      await this.savePauseWindows();
    },

    async savePauseWindows() {
      this.pauseWindowsSaving = true;
      this.pauseWindowsError = '';
      this.pauseWindowsMsg = '';
      try {
        const res = await fetch('/api/supervisor/settings/pause-windows', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ windows: this.pauseWindows }),
        });
        const data = await res.json();
        if (!res.ok) {
          this.pauseWindowsError = data.error?.message || 'Enregistrement refusé.';
          await this.loadSettings();
          return;
        }
        this.pauseWindows = data.windows || [];
        this.pauseWindowsMsg = 'Plages enregistrées.';
        await this.loadQuotas();
        setTimeout(() => { this.pauseWindowsMsg = ''; }, 4000);
      } catch {
        this.pauseWindowsError = 'Erreur réseau.';
        await this.loadSettings();
      } finally {
        this.pauseWindowsSaving = false;
      }
    },

    async setPlanningImportWeekday(n, checked) {
      const has = this.planningImportWeekdays.includes(n);
      if (checked === has) return;
      const set = new Set(this.planningImportWeekdays);
      if (checked) set.add(n);
      else set.delete(n);
      if (set.size === 0) {
        this.planningImportDaysError = 'Cochez au moins un jour.';
        this.planningImportDaysMsg = '';
        return;
      }
      this.planningImportWeekdays = [...set].sort((a, b) => a - b);
      await this.savePlanningImportDays();
    },

    async setPlanningSkipFrenchHolidays(checked) {
      if (checked === this.planningSkipFrenchHolidays) return;
      this.planningSkipFrenchHolidays = checked === true;
      await this.savePlanningImportDays();
    },

    showPlanningImportDaysMsg(text) {
      if (this._planningImportDaysMsgTimer) {
        clearTimeout(this._planningImportDaysMsgTimer);
        this._planningImportDaysMsgTimer = null;
      }
      this.planningImportDaysMsg = text;
      this._planningImportDaysMsgTimer = setTimeout(() => {
        this.planningImportDaysMsg = '';
        this._planningImportDaysMsgTimer = null;
      }, 4000);
    },

    async savePlanningImportDays() {
      this.planningImportDaysError = '';
      try {
        const res = await fetch('/api/supervisor/settings/planning-import-days', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            weekdays: this.planningImportWeekdays,
            skipFrenchHolidays: this.planningSkipFrenchHolidays === true,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          this.planningImportDaysError = data.error?.message || 'Enregistrement refusé.';
          this.planningImportDaysMsg = '';
          await this.loadSettings();
          return;
        }
        this.planningImportWeekdays = data.weekdays || this.planningImportWeekdays;
        this.planningSkipFrenchHolidays = data.skipFrenchHolidays === true;
        const hadPreview = !!this.planningImportResult && !this.planningImportApplied;
        this.clearPlanningPreview();
        this.showPlanningImportDaysMsg(
          hadPreview
            ? 'Jours d’import enregistrés. Relancez l’analyse.'
            : 'Jours d’import enregistrés.'
        );
      } catch {
        this.planningImportDaysError = 'Erreur réseau.';
        this.planningImportDaysMsg = '';
        await this.loadSettings();
      }
    },

    // ── Live ─────────────────────────────────────
    buildLiveFromSnapshot(snapshot) {
      this.livePauses = [];
      for (const entry of snapshot) {
        for (const p of entry.pauses) {
          this.livePauses.push({
            id:        p.id,
            agent_matricule: p.agent_matricule,
            nom: p.nom,
            prenom: p.prenom,
            agentName: `${p.prenom} ${p.nom}`,
            offerCode: entry.offer.code,
            offerLabel: entry.offer.label,
            startTime: p.start_time,
            _forcing:  false,
          });
        }
      }
    },

    hashOfferId(offerId) {
      if (Number.isInteger(offerId)) return offerId;
      if (typeof offerId === 'number' && Number.isFinite(offerId)) return Math.trunc(offerId);
      const str = String(offerId ?? '');
      let hash = 0;
      for (let i = 0; i < str.length; i += 1) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
      }
      return Math.abs(hash);
    },

    resolveOfferColor(offerId, savedColor) {
      const pastelColors = ['#ffb3ba', '#ffdfba', '#ffffba', '#baffc9', '#bae1ff'];
      if (typeof savedColor === 'string') {
        const normalized = savedColor.trim().toLowerCase();
        if (/^#[0-9a-f]{6}$/.test(normalized)) return normalized;
      }
      const idx = this.hashOfferId(offerId) % pastelColors.length;
      return pastelColors[idx];
    },

    offerLabel(code) {
      if (!code) return 'Offre';
      const quota = this.quotas.find((q) => q.offer?.code === code);
      if (quota?.offer?.label) return quota.offer.label;
      const admin = this.offersAdminRows.find((o) => o.code === code);
      if (admin?.label) return admin.label;
      const hist = this.histOffers.find((o) => o.code === code);
      if (hist?.label) return hist.label;
      return 'Offre';
    },

    resolveOfferColorByCode(offerCode) {
      const quota = this.quotas.find(q => q.offer?.code === offerCode);
      if (quota) return this.resolveOfferColor(quota.offer.id ?? quota.offer.code, quota.offer.color);
      return this.resolveOfferColor(offerCode, null);
    },

    async forceStop(p) {
      p._forcing = true;
      try {
        const res  = await fetch('/api/supervisor/pause/force-stop', {
          method:      'POST',
          headers:     { 'Content-Type': 'application/json' },
          credentials: 'include',
          body:        JSON.stringify({ agent_matricule: p.agent_matricule }),
        });
        if (!res.ok) {
          const d = await res.json();
          alert(d.error?.message || 'Erreur lors du retour forcé.');
          p._forcing = false;
        }
        // La ligne disparaîtra via l'événement Socket pause:stopped
      } catch {
        alert('Erreur réseau.');
        p._forcing = false;
      }
    },

    // ── Historique ───────────────────────────────
    async loadHistory(page = 1) {
      this.histLoading = true;
      try {
        const params = new URLSearchParams({ page, limit: 50 });
        if (this.histFilter.offerCode) params.append('offerCode', this.histFilter.offerCode);
        if (this.histFilter.from)      params.append('from', this.histFilter.from + 'T00:00:00.000Z');
        if (this.histFilter.to)        params.append('to',   this.histFilter.to   + 'T23:59:59.999Z');

        const res  = await fetch(`/api/supervisor/history?${params}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        const data = await res.json();
        this.histRows       = (data.rows || []).map((row) => ({ ...row, _excluding: false }));
        this.histPagination = data.pagination || { page: 1, limit: 50, total: 0, pages: 0 };
      } catch { /* silencieux */ }
      finally { this.histLoading = false; }
    },

    sortHistory(key) {
      if (this.histSort.key === key) {
        this.histSort.dir = this.histSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        this.histSort.key = key;
        this.histSort.dir = (key === 'start_time' || key === 'start_date') ? 'desc' : 'asc';
      }
    },

    async setPauseExcludedFromBudget(row, excluded) {
      const confirmMsg = FlowiDirectoryCredits.historyExcludeConfirmMessage(excluded);
      if (!confirm(confirmMsg)) return;
      row._excluding = true;
      try {
        const res = await fetch(`/api/supervisor/pauses/${row.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ excluded_from_budget: excluded }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(data.error?.message || 'Erreur.');
          return;
        }
        row.excluded_from_budget = data.pause?.excluded_from_budget === true;
        this.applyDirectoryPauseBudget(
          data.pause?.agent_matricule || row.agent_matricule,
          data.pauseBudget
        );
      } catch {
        alert('Erreur réseau.');
      } finally {
        row._excluding = false;
      }
    },

    applyDirectoryPauseBudget(matricule, pauseBudget) {
      if (!matricule || !pauseBudget) return;
      const rowsPlain = (this.directoryRows || []).map((a) => ({
        matricule: a.matricule,
        pauseWindowOpen: a.pauseWindowOpen,
        pauseBudget: this._plainPauseBudget(a.pauseBudget),
        _creditsAt: a._creditsAt,
      }));
      const { rows, directoryCreditsAt } = FlowiDirectoryCredits.stampAgentPauseBudget(
        rowsPlain,
        matricule,
        this._plainPauseBudget(pauseBudget),
        Date.now()
      );
      this.directoryCreditsAt = directoryCreditsAt;
      for (const stamped of rows) {
        const agent = this.directoryRows.find((a) => a.matricule === stamped.matricule);
        if (!agent) continue;
        agent.pauseBudget = stamped.pauseBudget;
        agent._creditsAt = stamped._creditsAt;
      }
      this.directoryLoaded = false;
    },

    applyDirectoryCredits(evt) {
      const src = evt && typeof evt === 'object' ? evt : {};
      const bySrc = src.budgetByMatricule && typeof src.budgetByMatricule === 'object'
        ? src.budgetByMatricule
        : {};
      const byPlain = {};
      for (const key of Object.keys(bySrc)) {
        byPlain[key] = this._plainPauseBudget(bySrc[key]);
      }
      const rowsPlain = (this.directoryRows || []).map((a) => ({
        matricule: a.matricule,
        pauseWindowOpen: a.pauseWindowOpen,
        pauseBudget: this._plainPauseBudget(a.pauseBudget),
      }));
      const { rows, directoryCreditsAt, empty } = FlowiDirectoryCredits.stampDirectoryCredits(
        rowsPlain,
        {
          pauseWindowOpen: src.pauseWindowOpen,
          budgetByMatricule: byPlain,
          emptyBudget: this._plainPauseBudget(src.emptyBudget),
        },
        Date.now()
      );
      this.directoryCreditsAt = directoryCreditsAt;
      if (empty) {
        this.directoryLoaded = false;
        return;
      }
      for (const stamped of rows) {
        const agent = this.directoryRows.find((a) => a.matricule === stamped.matricule);
        if (!agent) continue;
        if (stamped.pauseWindowOpen !== undefined) agent.pauseWindowOpen = stamped.pauseWindowOpen;
        agent.pauseBudget = stamped.pauseBudget;
        agent._creditsAt = stamped._creditsAt;
      }
    },

    _plainPauseBudget(budget) {
      if (!budget || typeof budget !== 'object') return budget || null;
      return {
        maxPauses: budget.maxPauses,
        startsUsed: budget.startsUsed,
        remainingStarts: budget.remainingStarts,
        remainingSeconds: budget.remainingSeconds,
        sittingCapSeconds: budget.sittingCapSeconds,
        canStart: budget.canStart,
        reason: budget.reason,
      };
    },

    // ── Annuaire ────────────────────────────────
    async loadDirectory(force = false) {
      if (this.directoryLoaded && !force) return;
      this.directoryLoading = true;
      this.directoryError = '';
      try {
        const res = await fetch('/api/supervisor/agents', {
          credentials: 'include',
          cache: 'no-store',
        });
        const data = await res.json();
        if (res.ok) {
          this.directoryRows = (data.agents || []).map(a => ({
            ...a,
            _saving: false,
            _releasing: false,
            _creditsAt: Date.now(),
          }));
          this.directoryCreditsAt = Date.now();
          this.directoryLoaded = true;
        } else {
          this.directoryError = data.error?.message || "Impossible de charger l'annuaire.";
        }
      } catch {
        this.directoryError = 'Erreur réseau.';
      } finally {
        this.directoryLoading = false;
      }
    },

    async loadAbout(force = false) {
      if (this.aboutLoaded && !force) return;
      this.aboutLoading = true;
      this.aboutError = '';
      try {
        const res = await fetch('/api/supervisor/system/about', {
          credentials: 'include',
          cache: 'no-store',
        });
        const data = await res.json();
        if (res.ok) {
          const rows = [];
          if (data.app) {
            rows.push({
              name: data.app.name || 'Flowi',
              role: 'Application',
              version: data.app.version || '—',
            });
          }
          if (data.runtime?.node) {
            rows.push({ name: 'Node.js', role: 'Exécution', version: data.runtime.node });
          }
          rows.push({
            name: 'PostgreSQL',
            role: 'Base de données',
            version: data.database || '—',
          });
          (data.dependencies || []).forEach((dep) => {
            rows.push({
              name: dep.name,
              role: dep.role || 'Composant serveur',
              version: dep.version || '—',
            });
          });
          (data.frontend || []).forEach((fe) => {
            rows.push({
              name: fe.name,
              role: fe.role || 'Interface',
              version: fe.version || '—',
            });
          });
          this.aboutRows = rows;
          this.aboutLoaded = true;
        } else {
          this.aboutError = data.error?.message || 'Impossible de charger les versions.';
        }
      } catch {
        this.aboutError = 'Erreur réseau.';
      } finally {
        this.aboutLoading = false;
      }
    },

    async createDirectoryAgent() {
      if (this.directorySaving) return;
      this.directorySaving = true;
      this.directoryError = '';
      this.directoryMsg = '';
      const payload = {
        matricule: this.directoryForm.matricule.trim(),
        nom: this.directoryForm.nom.trim(),
        prenom: this.directoryForm.prenom.trim(),
      };

      if (!payload.matricule || !payload.nom || !payload.prenom) {
        this.directoryError = 'Matricule, nom et prénom sont requis.';
        this.directorySaving = false;
        return;
      }

      try {
        const res = await fetch('/api/supervisor/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (res.ok) {
          this.directoryForm = { matricule: '', nom: '', prenom: '' };
          this.directoryMsg = 'Agent ajouté.';
          this.directoryLoaded = false;
          await this.loadDirectory(true);
        } else if (res.status === 409) {
          this.directoryError = 'Ce matricule existe déjà.';
        } else {
          this.directoryError = data.error?.message || "Impossible d'ajouter l'agent.";
        }
      } catch {
        this.directoryError = 'Erreur réseau.';
      } finally {
        this.directorySaving = false;
      }
    },

    async toggleDirectoryAgentStatus(agent) {
      if (agent._saving) return;
      agent._saving = true;
      this.directoryError = '';
      this.directoryMsg = '';
      try {
        const action = agent.is_active === true ? 'deactivate' : 'activate';
        const res = await fetch(`/api/supervisor/agents/${encodeURIComponent(agent.matricule)}/${action}`, {
          method: 'PATCH',
          credentials: 'include',
        });
        const data = await res.json();
        if (res.ok && data.agent) {
          agent.is_active = data.agent.is_active;
          this.directoryMsg = data.agent.is_active === true ? 'Agent réactivé.' : 'Agent désactivé.';
        } else {
          this.directoryError = data.error?.message || "Impossible de modifier le statut de l'agent.";
        }
      } catch {
        this.directoryError = 'Erreur réseau.';
      } finally {
        agent._saving = false;
      }
    },

    async releaseDirectorySession(agent) {
      if (!agent || agent._releasing) return;
      const hasLivePause = this.livePauses.some(p => p.agent_matricule === agent.matricule);
      const shouldForceStop = hasLivePause
        ? window.confirm("Cet agent est actuellement en pause. Voulez-vous également forcer son retour de pause ?")
        : false;

      agent._releasing = true;
      this.directoryError = '';
      this.directoryMsg = '';
      try {
        const res = await fetch('/api/supervisor/sessions/release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ agent_matricule: agent.matricule }),
        });
        const data = await res.json();
        if (!res.ok) {
          this.directoryError = data.error?.message || 'Erreur lors de la libération de session.';
          return;
        }
        if (!data.released) {
          this.directoryError = 'Aucune session active a liberer pour cet agent.';
          return;
        }

        if (!shouldForceStop) {
          if (data.kicked) {
            this.directoryMsg = 'Session libérée et agent expulsé.';
          } else {
            this.directoryMsg = 'Session libérée.';
          }
          return;
        }

        const forceRes = await fetch('/api/supervisor/pause/force-stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ agent_matricule: agent.matricule }),
        });
        const forceData = await forceRes.json();
        if (!forceRes.ok) {
          const forceError = forceData.error?.message || 'retour de pause non exécuté';
          this.directoryError = `Session libérée, mais échec du retour de pause forcé (${forceError}).`;
          return;
        }

        if (data.kicked) {
          this.directoryMsg = 'Session libérée, agent expulsé et retour de pause forcé.';
        } else {
          this.directoryMsg = 'Session libérée et retour de pause forcé.';
        }
      } catch {
        this.directoryError = 'Erreur reseau.';
      } finally {
        agent._releasing = false;
      }
    },

    // ── Offres (admin) ────────────────────────────
    _normalizeHexColor(color) {
      if (typeof color !== 'string') return null;
      const normalized = color.trim().toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(normalized)) return null;
      return normalized;
    },

    offerAllowedPercent(offer) {
      const q = this.quotas.find((x) => x.offer.code === offer?.code);
      const v = q?.rule?.allowedPercent;
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    },

    offerPercentBadge(offer) {
      const p = this.offerAllowedPercent(offer);
      return p == null ? '% —' : `${p} %`;
    },

    parseOfferAllowedPercent() {
      const raw = this.offerForm.allowed_percent;
      if (raw === '' || raw === null || raw === undefined) return { ok: true, value: null };
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, value: null };
      return { ok: true, value: n };
    },

    async putOfferAllowedPercent(code, percent) {
      const res = await fetch(`/api/supervisor/quotas/${encodeURIComponent(code)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ allowedPercent: percent }),
      });
      let data = {};
      try { data = await res.json(); } catch { /* ignore */ }
      return { ok: res.ok, data };
    },

    async retryOfferPercent() {
      if (!this.offerPercentRetry || this.offerPercentRetrying) return;
      this.offerPercentRetrying = true;
      this.offerError = '';
      try {
        const { ok, data } = await this.putOfferAllowedPercent(
          this.offerPercentRetry.code,
          this.offerPercentRetry.percent
        );
        if (!ok) {
          this.offerError = data.error?.message || this.offerPercentRetry.message;
          return;
        }
        this.offerPercentRetry = null;
        this.offerMsgOk = true;
        this.offerMsg = '% enregistré.';
        await Promise.all([this.loadOffersAdmin(), this.loadQuotas()]);
      } catch {
        this.offerError = 'Erreur réseau.';
      } finally {
        this.offerPercentRetrying = false;
      }
    },

    _resetOfferForm() {
      this.offerForm = {
        mode: 'create',
        originalCode: '',
        code: '',
        label: '',
        default_quota: 2,
        allowed_percent: 20,
        color: '#000000',
        useDefaultColor: true,
      };
    },

    async loadOffersAdmin() {
      this.offersAdminLoading = true;
      this.offerError = '';
      try {
        const res = await fetch('/api/supervisor/offers', {
          credentials: 'include',
          cache: 'no-store',
        });
        const data = await res.json();
        if (!res.ok) {
          this.offerError = data.error?.message || 'Impossible de charger les offres.';
          return;
        }
        this.offersAdminRows = data.offers || [];
      } catch {
        this.offerError = 'Erreur réseau.';
      } finally {
        this.offersAdminLoading = false;
      }
    },

    startCreateOffer() {
      this.offerError = '';
      this.offerMsg = '';
      this._resetOfferForm();
      this.expandedOfferCode = '__new__';
    },

    cancelOfferPanel() {
      this.expandedOfferCode = null;
      this._resetOfferForm();
      this.offerError = '';
      this.offerMsg = '';
    },

    _parseDefaultQuota(raw) {
      if (raw === null || raw === undefined || raw === '') return 2;
      const n = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
      if (!Number.isFinite(n) || n < 0) return 2;
      return Math.min(Math.floor(n), 999999);
    },

    /** Remplit offerForm depuis une ligne API (quota JSON tolérant). */
    editOffer(offer) {
      if (!offer) return;
      this.offerError = '';
      this.offerMsg = '';
      const hex = typeof offer.color === 'string'
        ? this._normalizeHexColor(offer.color)
        : null;
      this.offerForm = {
        mode: 'edit',
        originalCode: offer.code,
        code: offer.code || '',
        label: offer.label != null ? String(offer.label) : '',
        default_quota: this._parseDefaultQuota(offer.default_quota),
        allowed_percent: this.offerAllowedPercent(offer) ?? '',
        color: hex || '#000000',
        useDefaultColor: !hex,
      };
    },

    openEditOffer(offer) {
      if (!offer) return;
      if (this.expandedOfferCode === offer.code) {
        this.cancelOfferPanel();
        return;
      }
      this.editOffer(offer);
      this.expandedOfferCode = offer.code;
    },

    resetOfferColor() {
      this.offerForm.useDefaultColor = true;
      this.offerForm.color = '#000000';
    },

    async saveOffer() {
      if (this.offerSaving) return;
      this.offerSaving = true;
      this.offerError = '';
      this.offerMsg = '';

      const label = (this.offerForm.label || '').trim();
      const defaultQuota = parseInt(this.offerForm.default_quota, 10);
      const color = this.offerForm.useDefaultColor
        ? null
        : this._normalizeHexColor(this.offerForm.color);

      if (!label) {
        this.offerError = 'Le nom de l’offre est requis.';
        this.offerSaving = false;
        return;
      }
      if (!Number.isInteger(defaultQuota) || defaultQuota < 0) {
        this.offerError = 'Le quota par défaut doit être un entier >= 0.';
        this.offerSaving = false;
        return;
      }
      if (!this.offerForm.useDefaultColor && !color) {
        this.offerError = 'Couleur invalide.';
        this.offerSaving = false;
        return;
      }

      const parsedPct = this.parseOfferAllowedPercent();
      if (!parsedPct.ok) {
        this.offerError = 'Le % autorisé doit être un nombre entre 0 et 100.';
        this.offerSaving = false;
        return;
      }

      const payload = {
        label,
        default_quota: defaultQuota,
        color,
      };

      try {
        let res;
        if (this.offerForm.mode === 'create') {
          res = await fetch('/api/supervisor/offers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload),
          });
        } else {
          res = await fetch(`/api/supervisor/offers/${encodeURIComponent(this.offerForm.originalCode)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload),
          });
        }

        const data = await res.json();
        if (!res.ok) {
          this.offerError = data.error?.message || "Impossible d'enregistrer l'offre.";
          return;
        }

        const created = this.offerForm.mode === 'create';
        const offerCode = created ? data.offer?.code : this.offerForm.originalCode;
        if (!offerCode) {
          this.offerError = "Impossible d'enregistrer l'offre.";
          return;
        }
        const shouldPutPercent = parsedPct.value !== null || !created;
        if (shouldPutPercent) {
          const pct = await this.putOfferAllowedPercent(offerCode, parsedPct.value);
          if (!pct.ok) {
            this.offerPercentRetry = {
              code: offerCode,
              percent: parsedPct.value,
              message: created ? 'Offre créée, % non enregistré' : 'Offre mise à jour, % non enregistré',
            };
            this.offerMsg = '';
            this.expandedOfferCode = null;
            this._resetOfferForm();
            await Promise.all([this.loadOffersAdmin(), this.loadQuotas()]);
            return;
          }
        }

        this.offerPercentRetry = null;
        this.offerMsgOk = true;
        this.offerMsg = created ? 'Offre créée.' : 'Offre mise à jour.';
        this.expandedOfferCode = null;
        this._resetOfferForm();
        await Promise.all([this.loadOffersAdmin(), this.loadQuotas()]);
      } catch {
        this.offerError = 'Erreur réseau.';
      } finally {
        this.offerSaving = false;
      }
    },

    async deactivateOffer(offer) {
      if (!offer || offer.is_active !== true) return;
      if (this.offerSaving) return;
      const name = offer.label || 'cette offre';
      const confirmed = window.confirm(`Désactiver « ${name} » ? Les pauses en cours ne seront pas interrompues.`);
      if (!confirmed) return;

      this.offerSaving = true;
      this.offerError = '';
      this.offerMsg = '';
      try {
        const res = await fetch(`/api/supervisor/offers/${encodeURIComponent(offer.code)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ is_active: false }),
        });
        const data = await res.json();
        if (!res.ok) {
          this.offerError = data.error?.message || "Impossible de désactiver l'offre.";
          return;
        }
        this.offerMsgOk = true;
        this.offerMsg = 'Offre désactivée.';
        if (this.expandedOfferCode === offer.code) this.expandedOfferCode = null;
        await Promise.all([this.loadOffersAdmin(), this.loadQuotas(), this.loadPlanningSlots()]);
      } catch {
        this.offerError = 'Erreur réseau.';
      } finally {
        this.offerSaving = false;
      }
    },

    async reactivateOffer(offer) {
      if (!offer || offer.is_active !== false) return;
      if (this.offerSaving) return;
      const name = offer.label || 'cette offre';
      const confirmed = window.confirm(`Réactiver « ${name} » ?`);
      if (!confirmed) return;

      this.offerSaving = true;
      this.offerError = '';
      this.offerMsg = '';
      try {
        const res = await fetch(`/api/supervisor/offers/${encodeURIComponent(offer.code)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ is_active: true }),
        });
        const data = await res.json();
        if (!res.ok) {
          this.offerError = data.error?.message || "Impossible de réactiver l'offre.";
          return;
        }
        this.offerMsgOk = true;
        this.offerMsg = 'Offre réactivée.';
        await Promise.all([this.loadOffersAdmin(), this.loadQuotas(), this.loadPlanningSlots()]);
      } catch {
        this.offerError = 'Erreur réseau.';
      } finally {
        this.offerSaving = false;
      }
    },

    async purgeOffer(offer) {
      if (!offer) return;
      if (this.offerSaving) return;
      const name = offer.label || 'cette offre';
      const confirmed = window.confirm(
        `Supprimer définitivement « ${name} » ? Si l’historique contient encore des pauses, l’offre disparaîtra de l’appli et sera effacée plus tard.`
      );
      if (!confirmed) return;

      this.offerSaving = true;
      this.offerError = '';
      this.offerMsg = '';
      try {
        const res = await fetch(`/api/supervisor/offers/${encodeURIComponent(offer.code)}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        const data = await res.json();
        if (!res.ok) {
          this.offerError = data.error?.message || "Impossible de supprimer l'offre.";
          return;
        }
        this.offerMsgOk = true;
        this.offerMsg = data.message || 'Offre supprimée.';
        if (this.expandedOfferCode === offer.code) this.expandedOfferCode = null;
        await Promise.all([this.loadOffersAdmin(), this.loadQuotas(), this.loadPlanningSlots()]);
      } catch {
        this.offerError = 'Erreur réseau.';
      } finally {
        this.offerSaving = false;
      }
    },

    endReasonLabel(reason, row) {
      const map = {
        manual:            'Manuel',
        auto_15m:          `Auto (${row?.max_minutes_at_end ?? this.settings.maxPauseMinutes} min)`,
        supervisor_forced: 'Forcé superviseur',
      };
      return map[reason] || reason || '—';
    },

    // ── Paramètres ───────────────────────────────
    parsePauseWindowsSetting(raw) {
      if (Array.isArray(raw)) {
        return raw.filter((w) => w && w.start && w.end).map((w) => ({ start: w.start, end: w.end }));
      }
      if (typeof raw !== 'string' || !raw.trim()) return [];
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((w) => w && w.start && w.end).map((w) => ({ start: w.start, end: w.end }));
      } catch {
        return [];
      }
    },

    parseImportWeekdaysSetting(raw) {
      let parsed = raw;
      if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw); } catch { parsed = [1, 2, 3, 4, 5]; }
      }
      if (!Array.isArray(parsed) || !parsed.length) return [1, 2, 3, 4, 5];
      const nums = [...new Set(parsed.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))]
        .sort((a, b) => a - b);
      return nums.length ? nums : [1, 2, 3, 4, 5];
    },

    async loadSettings() {
      try {
        const res  = await fetch('/api/supervisor/settings', {
          credentials: 'include',
          cache: 'no-store',
        });
        const data = await res.json();
        this.settings.historyRetentionDays = parseInt(data.settings?.history_retention_days || 30, 10);
        this.settings.maxPauseMinutes      = parseInt(data.settings?.max_pause_minutes      || 15, 10);
        const rawMaxPauses = data.settings?.max_pauses_per_agent;
        this.settings.maxPausesPerAgent    = rawMaxPauses && String(rawMaxPauses).trim() !== '' ? String(parseInt(rawMaxPauses, 10)) : '';
        this.settings.anonymizeAgentNames  = data.settings?.anonymize_agent_names === '1';
        this.settings.github_owner         = typeof data.settings?.github_owner === 'string' ? data.settings.github_owner : '';
        this.settings.github_repo          = typeof data.settings?.github_repo === 'string' ? data.settings.github_repo : '';
        this.githubTokenConfigured         = !!data.settings?.github_token_configured;
        this.githubTokenInput              = '';
        this.supervisorPinConfigured       = !!data.settings?.supervisor_pin_configured;
        this.supervisorPinInput            = '';
        this.pauseWindows                  = this.parsePauseWindowsSetting(data.settings?.pause_windows);
        this.planningImportWeekdays        = this.parseImportWeekdaysSetting(data.settings?.planning_import_weekdays);
        this.planningSkipFrenchHolidays    = data.settings?.planning_skip_french_holidays !== '0';
        this.updateThresholds();
      } catch { /* silencieux */ }
    },

    normalizeGithubSetting(s) {
      if (typeof s !== 'string') return '';
      return s.trim().replace(/\s+/g, ' ');
    },

    async saveSupervisorPin() {
      const raw = typeof this.supervisorPinInput === 'string' ? this.supervisorPinInput.trim() : '';
      if (raw === '') {
        this.supervisorPinMsgOk = false;
        this.supervisorPinMsg = 'Saisissez un nouveau code (4 à 6 chiffres) pour le modifier.';
        setTimeout(() => { this.supervisorPinMsg = ''; }, 4000);
        return;
      }
      this.supervisorPinSaving = true;
      this.supervisorPinMsg    = '';
      try {
        const res = await fetch('/api/supervisor/settings', {
          method:      'PUT',
          headers:     { 'Content-Type': 'application/json' },
          credentials: 'include',
          body:        JSON.stringify({ supervisor_pin: raw }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          this.supervisorPinMsgOk = true;
          this.supervisorPinMsg   = 'Code PIN enregistré.';
          await this.loadSettings();
        } else {
          this.supervisorPinMsgOk = false;
          this.supervisorPinMsg   = data.error?.message || 'Erreur.';
        }
      } catch {
        this.supervisorPinMsgOk = false;
        this.supervisorPinMsg   = 'Erreur réseau.';
      } finally {
        this.supervisorPinSaving = false;
        setTimeout(() => { this.supervisorPinMsg = ''; }, 4000);
      }
    },

    async saveGithubOta() {
      this.githubOtaSaving = true;
      this.githubOtaMsg    = '';
      const body = {
        github_owner: this.normalizeGithubSetting(this.settings.github_owner),
        github_repo:  this.normalizeGithubSetting(this.settings.github_repo),
      };
      const t = typeof this.githubTokenInput === 'string' ? this.githubTokenInput.trim() : '';
      if (t !== '') body.github_token = t;
      try {
        const res = await fetch('/api/supervisor/settings', {
          method:      'PUT',
          headers:     { 'Content-Type': 'application/json' },
          credentials: 'include',
          body:        JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          this.githubOtaMsgOk = true;
          this.githubOtaMsg   = 'Paramètres GitHub enregistrés.';
          await this.loadSettings();
        } else {
          this.githubOtaMsgOk = false;
          this.githubOtaMsg   = data.error?.message || 'Erreur.';
        }
      } catch {
        this.githubOtaMsgOk = false;
        this.githubOtaMsg   = 'Erreur réseau.';
      } finally {
        this.githubOtaSaving = false;
        setTimeout(() => { this.githubOtaMsg = ''; }, 4000);
      }
    },

    async saveGithubOtaClearToken() {
      this.githubOtaSaving = true;
      this.githubOtaMsg    = '';
      try {
        const res = await fetch('/api/supervisor/settings', {
          method:      'PUT',
          headers:     { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            github_owner: this.normalizeGithubSetting(this.settings.github_owner),
            github_repo:  this.normalizeGithubSetting(this.settings.github_repo),
            github_token: '',
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          this.githubOtaMsgOk = true;
          this.githubOtaMsg   = 'Jeton supprimé.';
          await this.loadSettings();
        } else {
          this.githubOtaMsgOk = false;
          this.githubOtaMsg   = data.error?.message || 'Erreur.';
        }
      } catch {
        this.githubOtaMsgOk = false;
        this.githubOtaMsg   = 'Erreur réseau.';
      } finally {
        this.githubOtaSaving = false;
        setTimeout(() => { this.githubOtaMsg = ''; }, 4000);
      }
    },

    async saveRetention() {
      this.settingsSaving = true;
      this.settingsMsg    = '';
      try {
        const res = await fetch('/api/supervisor/settings/history-retention-days', {
          method:      'PUT',
          headers:     { 'Content-Type': 'application/json' },
          credentials: 'include',
          body:        JSON.stringify({ days: this.settings.historyRetentionDays }),
        });
        const data = await res.json();
        if (res.ok) {
          this.settingsMsgOk = true;
          this.settingsMsg   = `Rétention mise à jour : ${data.historyRetentionDays} jours.`;
        } else {
          this.settingsMsgOk = false;
          this.settingsMsg   = data.error?.message || 'Erreur.';
        }
      } catch {
        this.settingsMsgOk = false;
        this.settingsMsg   = 'Erreur réseau.';
      } finally {
        this.settingsSaving = false;
        setTimeout(() => { this.settingsMsg = ''; }, 4000);
      }
    },

    async saveMaxPause() {
      this.maxPauseSaving = true;
      this.maxPauseMsg    = '';
      try {
        const res = await fetch('/api/supervisor/settings/max-pause-minutes', {
          method:      'PUT',
          headers:     { 'Content-Type': 'application/json' },
          credentials: 'include',
          body:        JSON.stringify({ minutes: this.settings.maxPauseMinutes }),
        });
        const data = await res.json();
        if (res.ok) {
          this.maxPauseMsgOk = true;
          this.maxPauseMsg   = `Durée maximale mise à jour : ${data.maxPauseMinutes} min.`;
          this.updateThresholds();
        } else {
          this.maxPauseMsgOk = false;
          this.maxPauseMsg   = data.error?.message || 'Erreur.';
        }
      } catch {
        this.maxPauseMsgOk = false;
        this.maxPauseMsg   = 'Erreur réseau.';
      } finally {
        this.maxPauseSaving = false;
        setTimeout(() => { this.maxPauseMsg = ''; }, 4000);
      }
    },

    async saveMaxPausesPerAgent() {
      this.maxPausesSaving = true;
      this.maxPausesMsg = '';
      const raw = typeof this.settings.maxPausesPerAgent === 'string'
        ? this.settings.maxPausesPerAgent.trim()
        : (this.settings.maxPausesPerAgent == null ? '' : String(this.settings.maxPausesPerAgent).trim());
      let maxPauses = null;
      if (raw !== '') {
        maxPauses = parseInt(raw, 10);
        if (!Number.isInteger(maxPauses) || maxPauses < 1 || maxPauses > 20) {
          this.maxPausesMsgOk = false;
          this.maxPausesMsg = 'Entier entre 1 et 20, ou vide.';
          this.maxPausesSaving = false;
          return;
        }
      }
      try {
        const res = await fetch('/api/supervisor/settings/max-pauses-per-agent', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ maxPauses }),
        });
        const data = await res.json();
        if (res.ok) {
          this.maxPausesMsgOk = true;
          this.settings.maxPausesPerAgent = data.maxPausesPerAgent == null ? '' : String(data.maxPausesPerAgent);
          this.maxPausesMsg = data.maxPausesPerAgent == null
            ? 'Pas de limite de pauses par agent.'
            : `Limite enregistrée : ${data.maxPausesPerAgent} pause(s) par plage.`;
        } else {
          this.maxPausesMsgOk = false;
          this.maxPausesMsg = data.error?.message || 'Erreur.';
        }
      } catch {
        this.maxPausesMsgOk = false;
        this.maxPausesMsg = 'Erreur réseau.';
      } finally {
        this.maxPausesSaving = false;
        setTimeout(() => { this.maxPausesMsg = ''; }, 4000);
      }
    },

    async saveAnonymizeAgentNames(enabled) {
      this.anonymizeSaving = true;
      this.anonymizeMsg = '';
      this.settings.anonymizeAgentNames = enabled === true;
      try {
        const res = await fetch('/api/supervisor/settings/anonymize-agent-names', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ enabled: enabled === true }),
        });
        const data = await res.json();
        if (res.ok) {
          this.anonymizeMsgOk = true;
          this.settings.anonymizeAgentNames = data.anonymizeAgentNames === true;
          this.anonymizeMsg = this.settings.anonymizeAgentNames
            ? 'Noms masqués sur l’écran agent.'
            : 'Noms visibles sur l’écran agent.';
        } else {
          this.anonymizeMsgOk = false;
          this.anonymizeMsg = data.error?.message || 'Erreur.';
          await this.loadSettings();
        }
      } catch {
        this.anonymizeMsgOk = false;
        this.anonymizeMsg = 'Erreur réseau.';
        await this.loadSettings();
      } finally {
        this.anonymizeSaving = false;
        setTimeout(() => { this.anonymizeMsg = ''; }, 4000);
      }
    },

    // ── Mode urgence ─────────────────────────────
    async loadMaintenanceMode() {
      try {
        const res  = await fetch('/api/supervisor/settings/maintenance-mode', {
          credentials: 'include',
          cache: 'no-store',
        });
        const data = await res.json();
        this.maintenanceMode = data.maintenanceMode ?? false;
      } catch { /* silencieux */ }
    },

    async toggleMaintenance() {
      if (this.maintenanceLoading) return;
      if (!this.maintenanceMode) {
        const ok = window.confirm(
          'Activer le mode urgence ? Aucun agent ne pourra plus démarrer de pause. Les pauses en cours continuent. Confirmer ?'
        );
        if (!ok) return;
      }
      this.maintenanceLoading = true;
      try {
        const res = await fetch('/api/supervisor/settings/maintenance-mode', {
          method:      'PUT',
          headers:     { 'Content-Type': 'application/json' },
          credentials: 'include',
          body:        JSON.stringify({ active: !this.maintenanceMode }),
        });
        const data = await res.json();
        if (res.ok) this.maintenanceMode = data.maintenanceMode;
      } catch { /* silencieux */ }
      finally { this.maintenanceLoading = false; }
    },

    // ── OTA ──────────────────────────────────────
    async checkUpdate() {
      this.otaChecking   = true;
      this.otaCheckError = '';
      this.otaCheckResult = null;
      try {
        const res  = await fetch('/api/supervisor/system/update/check', {
          credentials: 'include',
          cache: 'no-store',
        });
        const data = await res.json();
        if (res.ok) {
          this.otaCheckResult = data;
          this.otaRunning = data.updateRunning;
        } else {
          this.otaCheckError = data.error?.message || 'Erreur lors de la vérification.';
        }
      } catch {
        this.otaCheckError = 'Erreur réseau.';
      } finally {
        this.otaChecking = false;
      }
    },

    async launchUpdate() {
      if (this.otaRunning) return;
      if (!confirm('Lancer la mise à jour ? Le serveur va redémarrer à la fin du processus.')) return;
      this.otaRunning    = true;
      this.otaLaunchError = '';
      this.otaLogs        = [];
      try {
        const res  = await fetch('/api/supervisor/system/update', {
          method:      'POST',
          credentials: 'include',
        });
        const data = await res.json();
        if (!res.ok) {
          this.otaLaunchError = data.error?.message || 'Erreur lors du lancement.';
          this.otaRunning = false;
        }
        // La progression est suivie via Socket.io (system:update-log / system:update-status)
      } catch {
        this.otaLaunchError = 'Erreur réseau.';
        this.otaRunning = false;
      }
    },

    _scrollOtaConsole() {
      this.$nextTick(() => {
        const el = this.$refs.otaConsole;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    // ── Socket.io ────────────────────────────────
    connectSocket() {
      const socket = io({
        transports: ['polling', 'websocket'],
        upgrade: true,
      });
      this._socket = socket;

      socket.on('connect',    () => { this.socketConnected = true;  socket.emit('join:supervisor'); });
      socket.on('disconnect', () => { this.socketConnected = false; });
      socket.on('connect_error', (err) => {
        this.socketConnected = false;
        console.warn('[socket] connect_error', err && err.message ? err.message : err);
      });

      socket.on('state:snapshot', (snapshot) => {
        if (!Array.isArray(snapshot)) return;
        this.buildLiveFromSnapshot(snapshot);
        // Mettre à jour les compteurs dans l'onglet quotas
        for (const entry of snapshot) {
          const q = this.quotas.find(x => x.offer.code === entry.offer.code);
          if (q) {
            q.effectiveQuota = entry.effectiveQuota;
            q.currentPaused  = entry.pauses.length;
            q.blocked        = entry.blocked;
          }
        }
      });

      socket.on('pause:started', (evt) => {
        const exists = this.livePauses.find(p => p.id === evt.pauseId);
        if (!exists) {
          this.livePauses.push({
            id:        evt.pauseId,
            agent_matricule: evt.agent_matricule,
            nom: evt.nom,
            prenom: evt.prenom,
            agentName: evt.agentName,
            offerCode: evt.offerCode,
            offerLabel: evt.offerLabel || this.offerLabel(evt.offerCode),
            startTime: evt.startTime,
            _forcing:  false,
          });
        }
        this._updateQuotaCounter(evt.offerCode);
        if (evt.pauseBudget && evt.agent_matricule) {
          this.applyDirectoryPauseBudget(evt.agent_matricule, evt.pauseBudget);
        }
      });

      socket.on('pause:stopped', (evt) => {
        this.livePauses = this.livePauses.filter(p => p.id !== evt.pauseId);
        this._updateQuotaCounter(evt.offerCode);
        // Recharger la page d'historique courante si on est sur cet onglet
        if (this.activeTab === 'history') this.loadHistory(this.histPagination.page);
        if (evt.pauseBudget && evt.agent_matricule) {
          this.applyDirectoryPauseBudget(evt.agent_matricule, evt.pauseBudget);
        }
      });

      socket.on('quota:updated', (evt) => {
        const q = this.quotas.find(x => x.offer.code === evt.offerCode);
        if (q) {
          q.effectiveQuota = evt.effectiveQuota;
          q.currentPaused  = evt.currentPaused;
          q.blocked        = evt.blockedForNewStarts;
        }
      });

      socket.on('quotas:update', (list) => {
        if (!Array.isArray(list)) return;
        for (const entry of list) {
          const q = this.quotas.find(x => x.offer.code === entry.code);
          if (!q) continue;
          q.effectiveQuota = entry.quota_max;
          q.currentPaused  = entry.pauses_en_cours;
          q.blocked        = (entry.pauses_en_cours ?? 0) >= (entry.quota_max ?? 0);
        }
        this.refreshCurrentSlotStats();
        if (this.activeTab === 'grid') this.loadPlanningSlots();
      });

      socket.on('offer:block-status', (evt) => {
        const q = this.quotas.find(x => x.offer.code === evt.offerCode);
        if (q) {
          q.blocked        = !evt.canStartPause;
          q.currentPaused  = evt.currentPaused ?? q.currentPaused;
          q.effectiveQuota = evt.effectiveQuota ?? q.effectiveQuota;
        }
      });

      // Paramètres système mis à jour depuis une autre session
      socket.on('system:settings-updated', (evt) => {
        if (!evt) return;
        if (evt.maxPauseMinutes !== undefined) { this.settings.maxPauseMinutes = evt.maxPauseMinutes; this.updateThresholds(); }
        if (evt.maxPausesPerAgent !== undefined) {
          this.settings.maxPausesPerAgent = evt.maxPausesPerAgent == null ? '' : String(evt.maxPausesPerAgent);
        }
        if (evt.anonymizeAgentNames !== undefined) {
          this.settings.anonymizeAgentNames = evt.anonymizeAgentNames === true;
        }
      });

      socket.on('directory:credits-updated', (evt) => {
        this.applyDirectoryCredits(evt);
      });

      // Mode urgence diffusé par le serveur
      socket.on('system:maintenance-mode', (evt) => {
        this.maintenanceMode = evt.active;
      });

      // Logs OTA en streaming
      socket.on('system:update-log', (evt) => {
        this.otaLogs.push({ stream: evt.stream, line: evt.line });
        this._scrollOtaConsole();
      });

      // Statut final du processus OTA
      socket.on('system:update-status', (evt) => {
        if (evt.status === 'completed' || evt.status === 'failed') {
          this.otaRunning = false;
          if (evt.status === 'completed') {
            this.otaCheckResult = null; // réinitialiser pour forcer re-check
          }
        }
        if (evt.status === 'running') this.otaRunning = true;
      });

      socket.on('session:update', (evt) => {
        if (!evt || !evt.agent_matricule) return;
        const agent = this.directoryRows.find(a => a.matricule === evt.agent_matricule);
        if (agent) agent.isOnline = !!evt.isOnline;
      });
    },

    _updateQuotaCounter(offerCode) {
      const q = this.quotas.find(x => x.offer.code === offerCode);
      if (!q) return;
      q.currentPaused = this.livePauses.filter(p => p.offerCode === offerCode).length;
      q.blocked = q.currentPaused >= q.effectiveQuota;
    },

    // ── Tick local chrono (1s) ───────────────────
    startTick() {
      this._tick = setInterval(() => {
        this._now = Date.now();
      }, 1000);
    },

    // ── Helpers ──────────────────────────────────
    elapsedSec(startTime) {
      return Math.max(0, Math.floor((this._now - new Date(startTime).getTime()) / 1000));
    },
    elapsedMin(startTime) {
      return Math.floor(this.elapsedSec(startTime) / 60);
    },
    formatDuration(totalSec) {
      const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
      const s = (totalSec % 60).toString().padStart(2, '0');
      return `${m}:${s}`;
    },
    formatRemainingSpoken(totalSec) {
      return FlowiDirectoryCredits.formatRemainingSpoken(totalSec);
    },
    directoryStartsLabel(agent) {
      return FlowiDirectoryCredits.directoryStartsLabel({
        pauseWindowOpen: agent && agent.pauseWindowOpen,
        pauseBudget: { remainingStarts: agent && agent.pauseBudget && agent.pauseBudget.remainingStarts },
      });
    },
    directoryAgentOnPause(matricule) {
      const pauses = this.livePauses || [];
      for (const p of pauses) {
        if (p.agent_matricule === matricule) return true;
      }
      return false;
    },
    directoryRemainingSeconds(agent) {
      const matricule = agent && agent.matricule;
      return FlowiDirectoryCredits.directoryRemainingSeconds(
        {
          pauseBudget: { remainingSeconds: agent && agent.pauseBudget && agent.pauseBudget.remainingSeconds },
          _creditsAt: agent && agent._creditsAt,
        },
        {
          now: this._now,
          onPause: this.directoryAgentOnPause(matricule),
          fallbackCreditsAt: this.directoryCreditsAt,
        }
      );
    },
    directoryTimeLabel(agent) {
      if (agent && agent.pauseWindowOpen === false) return 'Hors plage';
      return FlowiDirectoryCredits.formatRemainingSpoken(this.directoryRemainingSeconds(agent));
    },
    formatTime(iso) {
      if (!iso) return '—';
      return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },
    formatDate(iso) {
      if (!iso) return '—';
      return new Date(iso).toLocaleDateString('fr-FR');
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('supervisor', supervisorApp);
});
