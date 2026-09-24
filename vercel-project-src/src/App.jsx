import { useState, useMemo, useEffect, useCallback, useRef } from "react";

// ─── window.storage shim (remplace l'API artifact-preview par localStorage) ──
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    async get(key) {
      const v = localStorage.getItem(key);
      if (v === null) throw new Error("Key not found");
      return { key, value: v, shared: false };
    },
    async set(key, value) {
      localStorage.setItem(key, value);
      return { key, value, shared: false };
    },
    async delete(key) {
      localStorage.removeItem(key);
      return { key, deleted: true, shared: false };
    },
  };
}

// ─── Appel IA — un seul point d'entrée, indépendant du fournisseur ────────────
const AI_PROVIDER = import.meta.env.VITE_AI_PROVIDER || "anthropic";
const AI_API_KEY = import.meta.env.VITE_AI_API_KEY || import.meta.env.VITE_ANTHROPIC_API_KEY;

async function callAI(prompt, maxTokens = 300) {
  if (AI_PROVIDER === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": AI_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`IA (Anthropic) ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || "";
  }

  if (AI_PROVIDER === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`IA (OpenAI) ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || "";
  }

  if (AI_PROVIDER === "mistral") {
    const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "mistral-small-latest",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`IA (Mistral) ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || "";
  }

  throw new Error(`Fournisseur IA inconnu: "${AI_PROVIDER}". Ajoute une branche dans callAI().`);
}

// ─── AIRTABLE CONFIG ──────────────────────────────────────────────────────────
const AIRTABLE_BASE = import.meta.env.VITE_AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = import.meta.env.VITE_AIRTABLE_TOKEN;
const AIRTABLE_TABLE_SUJET = "Sujet";
const AIRTABLE_TABLE_ACTIVITE = "Activité";

const STATUS_TO_AT = { in_progress: "En cours", waiting: "En attente", blocked: "Bloqué", futur: "Futur", done: "Terminer" };
const AT_TO_STATUS = Object.fromEntries(Object.entries(STATUS_TO_AT).map(([k, v]) => [v, k]));

const PRIORITY_TO_AT = { p1: "P1", p2: "P2", p3: "P3" };
const AT_TO_PRIORITY = Object.fromEntries(Object.entries(PRIORITY_TO_AT).map(([k, v]) => [v, k]));

const TYPE_TO_AT = { design: "Design", relance: "Relance", feedback: "Feedback", validation: "Validation", update: "Update", action: "Action", note: "Note" };
const AT_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_AT).map(([k, v]) => [v, k]));

const PLATFORM_TO_AT = { TV: "TV", Web: "Web", Mobile: "Mobile", STB: "STB", "STB Less": "STBLess", Connect: "Connect", Other: "Other" };
const AT_TO_PLATFORM = Object.fromEntries(Object.entries(PLATFORM_TO_AT).map(([k, v]) => [v, k]));

async function airtableRequest(table, path = "", options = {}) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}${path}`;
  const headers = { "Authorization": `Bearer ${AIRTABLE_TOKEN}` };
  if (options.body) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Airtable ${res.status} sur "${table}"\nURL: ${url}\nBase: ${AIRTABLE_BASE || "(vide)"}\nToken présent: ${AIRTABLE_TOKEN ? "oui (" + AIRTABLE_TOKEN.slice(0, 6) + "…)" : "NON — variable manquante"}\n${errText.slice(0, 200)}`);
  }
  return res.json();
}

async function airtableListAll(table) {
  let records = [];
  let offset = null;
  do {
    const qs = offset ? `?pageSize=100&offset=${offset}` : `?pageSize=100`;
    const data = await airtableRequest(table, qs);
    records = records.concat(data.records);
    offset = data.offset || null;
  } while (offset);
  return records;
}

async function airtableCreate(table, fields) {
  const data = await airtableRequest(table, "", { method: "POST", body: JSON.stringify({ records: [{ fields }] }) });
  return data.records[0];
}

async function airtableUpdate(table, id, fields) {
  const data = await airtableRequest(table, "", { method: "PATCH", body: JSON.stringify({ records: [{ id, fields }] }) });
  return data.records[0];
}

async function airtableDelete(table, id) {
  await airtableRequest(table, `?records[]=${id}`, { method: "DELETE" });
}

function projectToAirtableFields(p) {
  const fields = {
    "Titre": p.title || "",
    "Description": p.description || "",
    "Prochaine action": p.nextAction || "",
    "Interlocuteur": (p.stakeholders || []).join(", "),
  };
  if (p.status && STATUS_TO_AT[p.status]) fields["Statut"] = STATUS_TO_AT[p.status];
  if (p.priority && PRIORITY_TO_AT[p.priority]) fields["Priorité"] = PRIORITY_TO_AT[p.priority];
  if (p.platforms) fields["Plateforme"] = p.platforms.map(pl => PLATFORM_TO_AT[pl] || pl).filter(Boolean);
  if (p.jiraUrl) fields["Lien Jira"] = p.jiraUrl;
  if (p.jiraKey) fields["Clé Jira"] = p.jiraKey;
  if (p.lastActivity) fields["Dernière activité"] = p.lastActivity;
  return fields;
}

function airtableFieldsToProject(record) {
  const f = record.fields || {};
  const platforms = (f["Plateforme"] || []).map(pl => AT_TO_PLATFORM[pl] || pl);
  return {
    id: record.id,
    title: f["Titre"] || "",
    status: AT_TO_STATUS[f["Statut"]] || "in_progress",
    priority: AT_TO_PRIORITY[f["Priorité"]] || null,
    platforms,
    description: f["Description"] || "",
    nextAction: f["Prochaine action"] || "",
    stakeholders: (f["Interlocuteur"] || "").split(",").map(s => s.trim()).filter(Boolean),
    jiraUrl: f["Lien Jira"] || null,
    jiraKey: f["Clé Jira"] || null,
    jiraLinks: f["Lien Jira"] ? [{ id: "primary", url: f["Lien Jira"], key: f["Clé Jira"] || "" }] : [],
    lastActivity: f["Dernière activité"] || null,
    createdAt: record.createdTime,
    timeline: [],
  };
}

function activityToAirtableFields(entry, sujetRecordId) {
  const fields = {
    "Sujets": [sujetRecordId],
    "Texte": entry.text || "",
    "Date": entry.date || today(),
    "En attente de retour": !!entry.waitingTag,
    "Temps passé": entry.timeSpent || 0,
  };
  if (entry.type && TYPE_TO_AT[entry.type]) fields["Type"] = TYPE_TO_AT[entry.type];
  return fields;
}

function airtableFieldsToActivity(record) {
  const f = record.fields || {};
  return {
    id: record.id,
    type: AT_TO_TYPE[f["Type"]] || "note",
    date: f["Date"] || "",
    text: f["Texte"] || "",
    waitingTag: !!f["En attente de retour"],
    timeSpent: f["Temps passé"] || 0,
    createdAt: record.createdTime,
  };
}

// ─── STORAGE KEY ──────────────────────────────────────────────────────────────
const STORAGE_KEY = "project-tracker-v1";

// ─── SEED DATA (chargé UNE seule fois si le storage est vide) ────────────────
const SEED_PROJECTS = [
  {
    id: "p1", title: "Refont Setting Web", platforms: ["Web"], status: "in_progress",
    jiraUrl: "https://jira.tv.sfr.net/browse/GFR-15596", jiraKey: "GFR-15596",
    stakeholders: ["Sylvie"], tags: ["en attente de retours"], lastActivity: "2026-09-10",
    timeline: [
      { id: "e1", date: "2025-07-18", type: "design",   text: "Bench + proposition de design v1 envoyé" },
      { id: "e2", date: "2025-08-01", type: "feedback",  text: "Demande de Sylvie → faire analyse du bench (points forts, points faibles)" },
      { id: "e3", date: "2025-08-07", type: "design",   text: "Bench finalisé + nouvelle proposition design envoyé" },
      { id: "e4", date: "2025-09-02", type: "relance",  text: "Relance envoyée" },
      { id: "e5", date: "2026-07-10", type: "relance",  text: "Relance envoyée" },
      { id: "e6", date: "2026-09-01", type: "update",   text: "Écran mis à jour → en attente de retours" },
    ],
    nextAction: "Attendre retours Sylvie",
    description: "Refonte complète des settings Web SFR",
    createdAt: "2025-07-18",
  },
  {
    id: "p2", title: "Recherche TV", platforms: ["STB"], status: "in_progress",
    jiraUrl: "https://jira.tv.sfr.net/browse/GFR-15486", jiraKey: "GFR-15486",
    stakeholders: ["Asmaa"], tags: ["en attente de retours"], lastActivity: "2026-07-10",
    timeline: [
      { id: "e1", date: "2025-07-17", type: "design",    text: "Étiquette texte ou icon sur la barre de recherche — design envoyé" },
      { id: "e2", date: "2025-08-05", type: "relance",   text: "Relance envoyée par mail" },
      { id: "e3", date: "2025-08-13", type: "design",    text: "2 protos (mosaic sans titre / mosaic avec titre) + écran aucun résultat envoyé" },
      { id: "e4", date: "2025-09-01", type: "design",    text: "v3 et v4 + v5 recommandé envoyé" },
      { id: "e5", date: "2025-09-09", type: "validation",text: "Validation v3" },
      { id: "e6", date: "2025-10-02", type: "update",    text: "Modification effectuée + message envoyé" },
      { id: "e7", date: "2025-10-15", type: "relance",   text: "Relance envoyée" },
      { id: "e8", date: "2026-07-10", type: "relance",   text: "Relance le 10/07/2026 → en attente de retours" },
    ],
    nextAction: "Relancer Asmaa pour validation finale",
    description: "Recherche TV — étiquettes et résultats",
    createdAt: "2025-07-17",
  },
  {
    id: "p3", title: "Recherche Web", platforms: ["Web"], status: "in_progress",
    jiraUrl: "https://jira.tv.sfr.net/browse/WEB-517", jiraKey: "WEB-517",
    stakeholders: ["Asmaa"], tags: ["en attente de retours"], lastActivity: "2026-09-10",
    timeline: [
      { id: "e1", date: "2025-07-22", type: "design",  text: "Bench + proposition de design v1 envoyé" },
      { id: "e2", date: "2025-08-05", type: "relance", text: "Relance envoyée par mail" },
      { id: "e3", date: "2025-08-13", type: "update",  text: "Test proto défilement au hover sur les tuiles" },
      { id: "e4", date: "2025-08-13", type: "design",  text: "Proto défilement + logo +2 envoyé" },
      { id: "e5", date: "2025-09-02", type: "relance", text: "Relance envoyée" },
    ],
    nextAction: "Faire les écrans en direct avec Asmaa",
    description: "Recherche Web SFR",
    createdAt: "2025-07-22",
  },
  {
    id: "p4", title: "Sous-titres TV", platforms: ["STB"], status: "in_progress",
    jiraUrl: null, jiraKey: null, stakeholders: [], tags: [], lastActivity: "2026-09-01",
    timeline: [
      { id: "e1", date: "2025-09-08", type: "action",  text: "Tailles à définir : Medium 54px, Small 75%, Large 125%" },
      { id: "e2", date: "2026-09-01", type: "relance", text: "Relancer pour validation des tailles" },
    ],
    nextAction: "Valider les tailles Medium/Small/Large, reproduire sur settings v2",
    description: "Définition des tailles de sous-titres TV",
    createdAt: "2025-09-08",
  },
  {
    id: "p5", title: "Reprendre FIP agrégé", platforms: ["TV"], status: "in_progress",
    jiraUrl: "https://jira.tv.sfr.net/browse/GFR-15592", jiraKey: "GFR-15592",
    stakeholders: [], tags: [], lastActivity: "2026-09-10",
    timeline: [{ id: "e1", date: "2026-09-10", type: "action", text: "Reprise du ticket FIP agrégé — en cours" }],
    nextAction: "Démarrer la conception",
    description: "Reprise de la FIP agrégée",
    createdAt: "2026-09-10",
  },
  {
    id: "p6", title: "Accessibilité télécommande à l'écran", platforms: ["TV"], status: "in_progress",
    jiraUrl: "https://jira.tv.sfr.net/browse/GFR-15740", jiraKey: "GFR-15740",
    stakeholders: ["Sylvie"], tags: [], lastActivity: "2026-03-11",
    timeline: [
      { id: "e1", date: "2026-02-12", type: "design",  text: "Proposition envoyée" },
      { id: "e2", date: "2026-02-26", type: "relance", text: "Relance" },
      { id: "e3", date: "2026-03-11", type: "design",  text: "Design envoyé" },
    ],
    nextAction: "Attendre retours",
    description: "Accessibilité — télécommande à l'écran",
    createdAt: "2026-02-12",
  },
  {
    id: "p7", title: "Suppression multiple des enregistrements", platforms: ["TV"], status: "in_progress",
    jiraUrl: null, jiraKey: null, stakeholders: [], tags: [], lastActivity: "2026-09-01",
    timeline: [{ id: "e1", date: "2026-09-01", type: "design", text: "Bench prêt + proposition 1er design prêt" }],
    nextAction: "Envoyer proposition design",
    description: "Suppression multiple des enregistrements TV",
    createdAt: "2026-09-01",
  },
  {
    id: "p8", title: "Créer font icon SFR", platforms: ["Other"], status: "in_progress",
    jiraUrl: null, jiraKey: null, stakeholders: [], tags: [], lastActivity: "2025-09-01",
    timeline: [
      { id: "e1", date: "2025-04-24", type: "relance", text: "Relance (sans réponse)" },
      { id: "e2", date: "2025-06-18", type: "relance", text: "Relance (sans réponse)" },
      { id: "e3", date: "2025-07-23", type: "relance", text: "Relance (sans réponse)" },
      { id: "e4", date: "2025-09-02", type: "relance", text: "Relance → en attente de retours" },
      { id: "e5", date: "2025-09-01", type: "action",  text: "Préparer export SVG, cleaner composants icon recording, exporter en SVG" },
    ],
    nextAction: "Exporter les SVG et importer sur Icomoon. Relancer Sylvie pour icons Recording.",
    description: "Créer la font icon pour SFR — export et intégration",
    createdAt: "2025-04-24",
  },
  {
    id: "p9", title: "FIP Mobile en direct", platforms: ["Mobile"], status: "in_progress",
    jiraUrl: null, jiraKey: null, stakeholders: ["Asmaa"], tags: [], lastActivity: "2026-08-10",
    timeline: [
      { id: "e1",  date: "2026-09-01", type: "action",  text: "Call avec Asmaa pour faire les écrans en direct — après son retour de vacances le 22" },
      { id: "e2",  date: "2025-11-01", type: "action",  text: "Faire bench IOS / Android - Terminer" },
      { id: "e3",  date: "2025-12-09", type: "design",  text: "Bench envoyé" },
      { id: "e4",  date: "2026-01-06", type: "relance", text: "Relance", waitingTag: true },
      { id: "e5",  date: "2026-01-23", type: "action",  text: "Réunion" },
      { id: "e6",  date: "2026-02-04", type: "design",  text: "Design montré" },
      { id: "e7",  date: "2026-02-05", type: "design",  text: "Design modifié et envoyé", waitingTag: true },
      { id: "e8",  date: "2026-02-18", type: "relance", text: "Relance", waitingTag: true },
      { id: "e9",  date: "2026-02-26", type: "relance", text: "Relance", waitingTag: true },
      { id: "e10", date: "2026-03-11", type: "relance", text: "Relance", waitingTag: true },
      { id: "e11", date: "2026-05-11", type: "relance", text: "Relance", waitingTag: true },
      { id: "e12", date: "2026-05-21", type: "action",  text: "Call prévu" },
      { id: "e13", date: "2026-05-26", type: "design",  text: "Design Quick WIN envoyé", waitingTag: true },
      { id: "e14", date: "2026-06-11", type: "design",  text: "Design 2027 envoyé", waitingTag: true },
      { id: "e15", date: "2026-06-29", type: "relance", text: "Relance", waitingTag: true },
      { id: "e16", date: "2026-08-05", type: "action",  text: "Call" },
      { id: "e17", date: "2026-08-10", type: "update",  text: "Mise à jour écran envoyé", waitingTag: true },
    ],
    nextAction: "Faire un call avec Asmaa pour les écrans FIP mobile",
    description: "FIP mobile — mode en direct",
    createdAt: "2026-09-01",
  },
  {
    id: "p10", title: "Refont Home STB8", platforms: ["STB"], status: "futur",
    jiraUrl: null, jiraKey: null, stakeholders: [], tags: [], lastActivity: null,
    timeline: [{ id: "e1", date: "2026-01-01", type: "note", text: "Manque ticket + barosat SFR + description du besoin" }],
    nextAction: "Créer le ticket Jira + définir le scope",
    description: "Refonte Home sur STB8",
    createdAt: "2026-01-01",
  },
  {
    id: "p11", title: "Profil Jeunesse STB8", platforms: ["STB"], status: "futur",
    jiraUrl: null, jiraKey: null, stakeholders: [], tags: [], lastActivity: null,
    timeline: [{ id: "e1", date: "2026-01-01", type: "note", text: "Manque ticket + brief et scope (création profil, choix kids/adult, mot de passe, interface kids, limitation temps de visionnage)" }],
    nextAction: "Créer le ticket Jira + définir le brief",
    description: "Profil jeunesse sur STB8",
    createdAt: "2026-01-01",
  },
  {
    id: "p12", title: "Plugin Figma — GIF en Sprite", platforms: ["Other"], status: "futur",
    jiraUrl: null, jiraKey: null, stakeholders: [], tags: [], lastActivity: null,
    timeline: [{ id: "e1", date: "2026-09-01", type: "note", text: "Plugin qui transforme un GIF en sprite + choix du nombre de frames dans le sprite sheet" }],
    nextAction: "Définir le scope technique",
    description: "Plugin Figma : transformer un GIF en sprite sheet",
    createdAt: "2026-09-01",
  },
];

// ─── DESIGN TOKENS ────────────────────────────────────────────────────────────
const T = {
  bg:           "#F5F6F8",
  bgSidebar:    "#FFFFFF",
  bgCard:       "#FFFFFF",
  bgHover:      "#F0F2F5",
  bgInput:      "#F0F2F5",
  bgSelected:   "#EEF0FF",
  bgNav:        "#1A1D27",
  border:       "#E3E6EC",
  borderNav:    "#2A2E3D",
  textPrimary:   "#0F1623",
  textSecondary: "#4B5563",
  textMuted:     "#9CA3AF",
  textXMuted:    "#CBD5E1",
  textNav:       "#9BA3B5",
  textNavActive: "#FFFFFF",
  accent:      "#6366F1",
  accentBg:    "#EEF0FF",
  accentText:  "#4338CA",
  inProgress: "#6366F1",
  waiting:    "#D97706",
  futur:      "#6B7280",
  done:       "#16A34A",
};

const ACTIVITY_TYPES = {
  design:     { label: "Design",       color: "#6366F1" },
  relance:    { label: "Relance",      color: "#D97706" },
  feedback:   { label: "Retour",       color: "#0891B2" },
  validation: { label: "Validation",   color: "#16A34A" },
  update:     { label: "Mise à jour",  color: "#7C3AED" },
  action:     { label: "Action",       color: "#2563EB" },
  note:       { label: "Note",         color: "#6B7280" },
};

const STATUS_CONFIG = {
  in_progress: { label: "En cours",   color: "#6366F1", bg: "#EEF0FF" },
  waiting:     { label: "En attente", color: "#D97706", bg: "#FEF3C7" },
  blocked:     { label: "Bloqué",     color: "#DC2626", bg: "#FEF2F2" },
  futur:       { label: "Futur",      color: "#6B7280", bg: "#F3F4F6" },
  done:        { label: "Terminé",    color: "#16A34A", bg: "#DCFCE7" },
};

const PRIORITY_CONFIG = {
  p1: { label: "P1", color: "#DC2626", bg: "#FEF2F2" },
  p2: { label: "P2", color: "#D97706", bg: "#FEF3C7" },
  p3: { label: "P3", color: "#6B7280", bg: "#F3F4F6" },
};

const PLATFORM_COLORS = {
  TV:         "#7C3AED",
  Web:        "#2563EB",
  Mobile:     "#DB2777",
  STB:        "#0891B2",
  "STB Less": "#0E7490",
  Connect:    "#059669",
  Other:      "#D97706",
};
const ALL_PLATFORMS = Object.keys(PLATFORM_COLORS);

// ─── NAV ITEMS ────────────────────────────────────────────────────────────────
const NAV_ITEMS = [
  {
    id: "dashboard", label: "Dashboard", available: true,
    icon: (a) => <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2 14l4-5 3 3 3-4 4 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><circle cx="14.5" cy="4.5" r="2" stroke="currentColor" strokeWidth="1.5" fill={a?"currentColor":"none"} fillOpacity={a?0.25:0}/></svg>,
  },
  {
    id: "projects", label: "Sujets", available: true,
    icon: (a) => <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="1.5" y="1.5" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill={a?"currentColor":"none"} fillOpacity={a?0.2:0}/><rect x="10.5" y="1.5" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill={a?"currentColor":"none"} fillOpacity={a?0.2:0}/><rect x="1.5" y="10.5" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill={a?"currentColor":"none"} fillOpacity={a?0.2:0}/><rect x="10.5" y="10.5" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill={a?"currentColor":"none"} fillOpacity={a?0.2:0}/></svg>,
  },
  {
    id: "kanban", label: "Kanban", available: true,
    icon: (a) => <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="1.5" y="3" width="4" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill={a?"currentColor":"none"} fillOpacity={a?0.2:0}/><rect x="7" y="3" width="4" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill={a?"currentColor":"none"} fillOpacity={a?0.2:0}/><rect x="12.5" y="3" width="4" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill={a?"currentColor":"none"} fillOpacity={a?0.2:0}/></svg>,
  },
  {
    id: "activity", label: "Activité", available: true,
    icon: (a) => <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.5" fill={a?"currentColor":"none"} fillOpacity={a?0.15:0}/><path d="M9 5v4l3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  },
  {
    id: "settings", label: "Réglages", available: false,
    icon: (a) => <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="2.5" stroke="currentColor" strokeWidth="1.5"/><path d="M9 1v2M9 15v2M1 9h2M15 9h2M2.93 2.93l1.41 1.41M13.66 13.66l1.41 1.41M2.93 15.07l1.41-1.41M13.66 4.34l1.41-1.41" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  },
];

// ─── UTILS ────────────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
function formatDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}
function timeAgo(d) {
  if (!d) return "";
  const days = Math.floor((Date.now() - new Date(d)) / 86400000);
  if (days === 0) return "Aujourd'hui";
  if (days === 1) return "Hier";
  if (days < 7)   return `Il y a ${days}j`;
  if (days < 30)  return `Il y a ${Math.floor(days / 7)} sem.`;
  if (days < 365) return `Il y a ${Math.floor(days / 30)} mois`;
  return `Il y a ${Math.floor(days / 365)} an${Math.floor(days / 365) > 1 ? "s" : ""}`;
}

// Sort timeline entries: by date desc, then by createdAt desc (for same-day entries)
// Copie robuste : essaie l'API Clipboard moderne, puis un fallback compatible iframe/sandbox
async function copyToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    throw new Error("clipboard API indisponible");
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }
}

function sortEntries(entries, dir = "desc") {
  return [...entries].sort((a, b) => {
    const dateA = a.date, dateB = b.date;
    if (dateA !== dateB) return dir === "desc" ? dateB.localeCompare(dateA) : dateA.localeCompare(dateB);
    // Same date → use createdAt if available, else stable
    const tA = a.createdAt || a.id || "";
    const tB = b.createdAt || b.id || "";
    return dir === "desc" ? tB.localeCompare(tA) : tA.localeCompare(tB);
  });
}
const IC = {
  Sparkle: () => <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 1.5l1.4 4.1L13.5 7l-4.1 1.4L8 12.5l-1.4-4.1L2.5 7l4.1-1.4L8 1.5z" fill="currentColor"/><path d="M13 11.5l0.6 1.6 1.6 0.6-1.6 0.6-0.6 1.6-0.6-1.6-1.6-0.6 1.6-0.6z" fill="currentColor"/></svg>,
  Search:  () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.4"/><path d="M9.5 9.5l2.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  Plus:    () => <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 2v9M2 6.5h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>,
  Jira:    () => <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M11.571 11.513H0a5.218 5.218 0 005.058 5.488l5.058 5.49v.01l5.059-5.49A5.218 5.218 0 0011.571 11.513zM23.143 0H11.572A5.218 5.218 0 0016.63 5.489l5.057 5.49v.01l5.057-5.49A5.218 5.218 0 0023.143 0z"/></svg>,
  Link:    () => <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M4 6a2 2 0 002.8 0l1.6-1.6a2 2 0 00-2.8-2.8l-.8.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><path d="M6 4a2 2 0 00-2.8 0L1.6 5.6a2 2 0 002.8 2.8l.8-.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>,
  User:    () => <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="4" r="2.2" stroke="currentColor" strokeWidth="1.3"/><path d="M1.5 10.5c0-2.2 2-3.5 4.5-3.5s4.5 1.3 4.5 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>,
  Clock:   () => <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.3"/><path d="M6 3.5V6l1.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>,
  Arrow:   () => <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  X:       () => <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  Chevron: () => <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1 2.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Save:    () => <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M10 10H2a1 1 0 01-1-1V3l2-2h6a1 1 0 011 1v7a1 1 0 01-1 1z" stroke="currentColor" strokeWidth="1.2"/><path d="M3 10V7h6v3" stroke="currentColor" strokeWidth="1.2"/><path d="M4 1v3h3V1" stroke="currentColor" strokeWidth="1.2"/></svg>,
  Trash:   () => <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1.5 3h9M4 3V2a1 1 0 011-1h2a1 1 0 011 1v1M5 5.5v3M7 5.5v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><path d="M2.5 3l.5 7a1 1 0 001 1h4a1 1 0 001-1l.5-7" stroke="currentColor" strokeWidth="1.2"/></svg>,
};

// ─── PLATFORM TAG ─────────────────────────────────────────────────────────────
function PlatformTag({ name, onRemove }) {
  const color = PLATFORM_COLORS[name] || T.futur;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color, background: `${color}12`, border: `1px solid ${color}25`, padding: "2px 6px 2px 8px", borderRadius: 5 }}>
      {name}
      {onRemove && (
        <button onClick={onRemove} style={{ background: "none", border: "none", cursor: "pointer", color, padding: 0, display: "flex", alignItems: "center", opacity: 0.7 }}>
          <IC.X />
        </button>
      )}
    </span>
  );
}

// ─── MULTI PLATFORM SELECTOR ──────────────────────────────────────────────────
function PlatformSelector({ platforms, onChange }) {
  const [open, setOpen] = useState(false);
  const toggle = (p) => onChange(platforms.includes(p) ? platforms.filter(x => x !== p) : [...platforms, p]);
  return (
    <div style={{ position: "relative", display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
      {platforms.map(p => <PlatformTag key={p} name={p} onRemove={() => toggle(p)} />)}
      <button onClick={() => setOpen(v => !v)} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 5, border: `1px dashed ${T.border}`, background: "transparent", color: T.textMuted, cursor: "pointer" }}>
        <IC.Plus /> Tag
      </button>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 98 }} onClick={() => setOpen(false)} />
          <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 99, background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.10)", overflow: "hidden", minWidth: 140 }}>
            {ALL_PLATFORMS.map(p => {
              const sel = platforms.includes(p);
              const col = PLATFORM_COLORS[p];
              return (
                <button key={p} onClick={() => toggle(p)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "7px 12px", fontSize: 12, fontWeight: sel ? 700 : 500, color: sel ? col : T.textPrimary, background: sel ? T.bgHover : "transparent", border: "none", cursor: "pointer", borderLeft: sel ? `3px solid ${col}` : "3px solid transparent" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: col, flexShrink: 0 }} />
                  {p}
                  {sel && <span style={{ marginLeft: "auto", fontSize: 10, color: col }}>✓</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── PRIORITY BADGE ───────────────────────────────────────────────────────────
function PriorityBadge({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const cfg = PRIORITY_CONFIG[value];
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button onClick={() => setOpen(v => !v)} style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, color: cfg ? cfg.color : T.textMuted, background: cfg ? cfg.bg : T.bgHover, padding: "3px 8px", borderRadius: 5, border: `1px solid ${cfg ? cfg.color + "30" : T.border}`, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
        {cfg ? cfg.label : "Priorité"}<IC.Chevron />
      </button>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 98 }} onClick={() => setOpen(false)} />
          <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 99, background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.10)", overflow: "hidden", minWidth: 100 }}>
            {Object.entries(PRIORITY_CONFIG).map(([k, v]) => (
              <button key={k} onClick={() => { onChange(k); setOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "7px 12px", fontSize: 12, fontWeight: k === value ? 800 : 500, color: v.color, background: k === value ? T.bgHover : "transparent", border: "none", cursor: "pointer", borderLeft: k === value ? `3px solid ${v.color}` : "3px solid transparent" }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: v.color, flexShrink: 0 }} />
                {v.label}
              </button>
            ))}
            {value && (
              <button onClick={() => { onChange(null); setOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "7px 12px", fontSize: 12, color: T.textMuted, background: "transparent", border: "none", cursor: "pointer", borderLeft: "3px solid transparent", borderTop: `1px solid ${T.border}` }}>
                Retirer
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── STATUS BADGE ─────────────────────────────────────────────────────────────
function StatusBadge({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const cfg = STATUS_CONFIG[value] || STATUS_CONFIG.futur;
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button onClick={() => setOpen(v => !v)} style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", color: cfg.color, background: cfg.bg, padding: "3px 8px", borderRadius: 5, border: `1px solid ${cfg.color}30`, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
        {cfg.label}<IC.Chevron />
      </button>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 98 }} onClick={() => setOpen(false)} />
          <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 99, background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.10)", overflow: "hidden", minWidth: 130 }}>
            {Object.entries(STATUS_CONFIG).map(([k, v]) => (
              <button key={k} onClick={() => { onChange(k); setOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "7px 12px", fontSize: 12, fontWeight: k === value ? 700 : 500, color: v.color, background: k === value ? T.bgHover : "transparent", border: "none", cursor: "pointer", borderLeft: k === value ? `3px solid ${v.color}` : "3px solid transparent" }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: v.color, flexShrink: 0 }} />
                {v.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── EDITABLE FIELD ───────────────────────────────────────────────────────────
function EditableText({ value, onChange, style = {}, multiline = false, placeholder = "" }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef();

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);

  function commit() {
    setEditing(false);
    if (draft.trim() !== value) onChange(draft.trim() || value);
  }

  if (!editing) {
    return (
      <span onClick={() => setEditing(true)} title="Cliquer pour modifier" style={{ cursor: "text", borderBottom: "1px dashed transparent", transition: "border-color 0.15s", ...style }}
        onMouseEnter={e => e.currentTarget.style.borderBottomColor = T.border}
        onMouseLeave={e => e.currentTarget.style.borderBottomColor = "transparent"}>
        {value || <span style={{ color: T.textMuted, fontStyle: "italic" }}>{placeholder}</span>}
      </span>
    );
  }

  const sharedStyle = { border: `1px solid ${T.accent}`, borderRadius: 5, outline: "none", fontFamily: "inherit", background: T.accentBg, color: T.textPrimary, padding: "2px 6px", ...style, borderBottom: `1px solid ${T.accent}` };

  return multiline
    ? <textarea ref={ref} value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === "Escape") { setDraft(value); setEditing(false); } }} style={{ ...sharedStyle, resize: "vertical", width: "100%", boxSizing: "border-box" }} rows={3} />
    : <input ref={ref} value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(value); setEditing(false); } }} style={{ ...sharedStyle, width: "100%", boxSizing: "border-box" }} placeholder={placeholder} />;
}

// ─── MODAL: ADD ACTIVITY ──────────────────────────────────────────────────────
function AddActivityModal({ project, onClose, onAdd }) {
  const [type, setType] = useState("update");
  const [text, setText] = useState("");
  const [date, setDate] = useState(today());
  const [noteContent, setNoteContent] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [waitingTag, setWaitingTag] = useState(false);

  const inputStyle = { width: "100%", boxSizing: "border-box", padding: "8px 10px", background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 7, color: T.textPrimary, fontSize: 13, outline: "none", fontFamily: "inherit" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(15,22,35,0.4)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 14, padding: 24, width: 440, maxWidth: "90vw", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.14)" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.textPrimary }}>Ajouter une activité</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 4 }}><IC.X /></button>
        </div>
        <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 18 }}>{(project.platforms || []).join(", ")} · {project.title}</div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary, display: "block", marginBottom: 7 }}>Type</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {Object.entries(ACTIVITY_TYPES).map(([key, cfg]) => (
              <button key={key} onClick={() => setType(key)} style={{ padding: "4px 11px", borderRadius: 20, fontSize: 11, fontWeight: 600, border: `1.5px solid ${type === key ? cfg.color : T.border}`, background: type === key ? cfg.color : "transparent", color: type === key ? "#fff" : T.textSecondary, cursor: "pointer", transition: "all 0.12s" }}>{cfg.label}</button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary, display: "block", marginBottom: 7 }}>Date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary, display: "block", marginBottom: 7 }}>Description courte</label>
          <textarea value={text} onChange={e => setText(e.target.value)} placeholder="Ex: Design v2 envoyé à Sylvie" rows={2} style={{ ...inputStyle, resize: "vertical" }} />
        </div>

        {!showNote ? (
          <button onClick={() => setShowNote(true)} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: T.textMuted, background: "none", border: `1px dashed ${T.border}`, borderRadius: 6, padding: "5px 10px", cursor: "pointer", marginBottom: 16 }}>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1 1h9v7H6.5L5.5 10 4.5 8H1V1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
            Ajouter une note complémentaire
          </button>
        ) : (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary }}>
                Note complémentaire <span style={{ color: T.textMuted, fontWeight: 400 }}>(masquée, dépliable)</span>
              </label>
              <button onClick={() => { setShowNote(false); setNoteContent(""); }} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2 }}><IC.X /></button>
            </div>
            <textarea value={noteContent} onChange={e => setNoteContent(e.target.value)} placeholder="Email reçu, commentaires Figma, compte-rendu, contexte détaillé…" rows={5} autoFocus style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }} />
          </div>
        )}

        {/* Waiting tag */}
        <div style={{ marginBottom: 20 }}>
          <button onClick={() => setWaitingTag(v => !v)} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700, border: `1.5px solid ${waitingTag ? "#D97706" : T.border}`, background: waitingTag ? "#FEF3C7" : "transparent", color: waitingTag ? "#D97706" : T.textMuted, cursor: "pointer", transition: "all 0.15s" }}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.3"/><path d="M5 3v2.5l1.5 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
            En attente de retour
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500, background: T.bgInput, border: `1px solid ${T.border}`, color: T.textSecondary, cursor: "pointer" }}>Annuler</button>
          <button onClick={() => { if (!text.trim()) return; onAdd({ type, text: text.trim(), date, ...(noteContent.trim() && { noteContent: noteContent.trim() }), ...(waitingTag && { waitingTag: true }) }); onClose(); }} style={{ padding: "8px 18px", borderRadius: 8, fontSize: 13, fontWeight: 700, background: T.accent, border: "none", color: "#fff", cursor: "pointer" }}>Ajouter</button>
        </div>
      </div>
    </div>
  );
}

// ─── MODAL: ADD PROJECT ───────────────────────────────────────────────────────
function AddSubjectModal({ onClose, onAdd }) {
  const [form, setForm] = useState({ title: "", platforms: [], status: "in_progress", jiraUrl: "", stakeholders: "", description: "", nextAction: "" });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const inputStyle = { width: "100%", boxSizing: "border-box", padding: "8px 10px", background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 7, color: T.textPrimary, fontSize: 13, outline: "none", fontFamily: "inherit" };
  const label = (t) => <label style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary, display: "block", marginBottom: 6 }}>{t}</label>;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(15,22,35,0.4)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 14, padding: 24, width: 460, maxWidth: "90vw", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.14)" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.textPrimary }}>Nouveau ticket</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 4 }}><IC.X /></button>
        </div>
        <div style={{ display: "grid", gap: 14 }}>
          <div>{label("Titre *")}<input value={form.title} onChange={e => set("title", e.target.value)} placeholder="Nom du ticket" style={inputStyle} /></div>
          <div>
            {label("Tags plateforme")}
            <div style={{ padding: "8px 10px", background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 7, minHeight: 36, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
              <PlatformSelector platforms={form.platforms} onChange={v => set("platforms", v)} />
            </div>
          </div>
          <div>{label("Statut")}<select value={form.status} onChange={e => set("status", e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>{Object.entries(STATUS_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
          <div>{label("Lien Jira")}<input value={form.jiraUrl} onChange={e => set("jiraUrl", e.target.value)} placeholder="https://jira.tv.sfr.net/browse/…" style={inputStyle} /></div>
          <div>{label("Parties prenantes (virgule)")}<input value={form.stakeholders} onChange={e => set("stakeholders", e.target.value)} placeholder="Sylvie, Asmaa…" style={inputStyle} /></div>
          <div>{label("Description")}<textarea value={form.description} onChange={e => set("description", e.target.value)} rows={2} style={{ ...inputStyle, resize: "vertical" }} /></div>
          <div>{label("Prochaine action")}<input value={form.nextAction} onChange={e => set("nextAction", e.target.value)} placeholder="Ex: Envoyer proposition design à Sylvie" style={inputStyle} /></div>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 22 }}>
          <button onClick={onClose} style={{ padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500, background: T.bgInput, border: `1px solid ${T.border}`, color: T.textSecondary, cursor: "pointer" }}>Annuler</button>
          <button onClick={() => {
            if (!form.title.trim()) return;
            const jiraKey = form.jiraUrl ? form.jiraUrl.split("/").pop() : null;
            onAdd({ id: `p${Date.now()}`, ...form, jiraKey, jiraUrl: form.jiraUrl || null, stakeholders: form.stakeholders.split(",").map(s => s.trim()).filter(Boolean), tags: [], lastActivity: today(), timeline: [], createdAt: today() });
            onClose();
          }} style={{ padding: "8px 18px", borderRadius: 8, fontSize: 13, fontWeight: 700, background: T.accent, border: "none", color: "#fff", cursor: "pointer" }}>Créer</button>
        </div>
      </div>
    </div>
  );
}

// ─── TIMELINE ENTRY ───────────────────────────────────────────────────────────
function TimelineEntry({ entry, isLast, onDelete, onEdit }) {
  const cfg = ACTIVITY_TYPES[entry.type] || ACTIVITY_TYPES.note;
  const [hover, setHover] = useState(false);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState({ type: entry.type, date: entry.date, text: entry.text, noteContent: entry.noteContent || "", waitingTag: entry.waitingTag || false });

  const hasNote = entry.noteContent && entry.noteContent.trim().length > 0;

  function commit() {
    if (draft.text.trim()) onEdit({ ...draft, text: draft.text.trim(), noteContent: draft.noteContent });
    setEditing(false);
  }

  // ── Edit mode ──
  if (editing) {
    return (
      <div style={{ display: "flex", gap: 14, marginBottom: isLast ? 0 : 20 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
          <div style={{ width: 9, height: 9, borderRadius: "50%", marginTop: 4, flexShrink: 0, background: cfg.color, border: `2px solid ${T.bgCard}`, boxShadow: `0 0 0 2px ${cfg.color}30` }} />
          {!isLast && <div style={{ width: 1.5, flex: 1, background: T.border, marginTop: 5 }} />}
        </div>
        <div style={{ flex: 1, background: T.bgInput, border: `1px solid ${T.accent}40`, borderRadius: 8, padding: "10px 12px", display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {Object.entries(ACTIVITY_TYPES).map(([k, c]) => (
                <button key={k} onClick={() => setDraft(d => ({ ...d, type: k }))} style={{ padding: "2px 8px", borderRadius: 20, fontSize: 10, fontWeight: 600, border: `1.5px solid ${draft.type === k ? c.color : T.border}`, background: draft.type === k ? c.color : "transparent", color: draft.type === k ? "#fff" : T.textSecondary, cursor: "pointer" }}>{c.label}</button>
              ))}
            </div>
            <input type="date" value={draft.date} onChange={e => setDraft(d => ({ ...d, date: e.target.value }))} style={{ padding: "2px 8px", background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 6, color: T.textPrimary, fontSize: 12, outline: "none", fontFamily: "inherit" }} />
          </div>
          <div>
            <label style={{ fontSize: 10, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 4 }}>Description courte</label>
            <textarea value={draft.text} onChange={e => setDraft(d => ({ ...d, text: e.target.value }))} rows={2} autoFocus onKeyDown={e => { if (e.key === "Escape") setEditing(false); }} style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 6, color: T.textPrimary, fontSize: 13, outline: "none", fontFamily: "inherit", resize: "vertical" }} />
          </div>
          <div>
            <label style={{ fontSize: 10, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 4 }}>Note complémentaire <span style={{ color: T.textXMuted, fontWeight: 400 }}>(masquée, dépliable)</span></label>
            <textarea value={draft.noteContent} onChange={e => setDraft(d => ({ ...d, noteContent: e.target.value }))} rows={4} placeholder="Email reçu, commentaires Figma, compte-rendu, contexte détaillé…" style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 6, color: T.textPrimary, fontSize: 13, outline: "none", fontFamily: "inherit", resize: "vertical", lineHeight: 1.6 }} />
          </div>
          <div style={{ display: "flex", gap: 6, justifyContent: "space-between", alignItems: "center" }}>
            <button onClick={() => setDraft(d => ({ ...d, waitingTag: !d.waitingTag }))} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 20, fontSize: 10, fontWeight: 700, border: `1.5px solid ${draft.waitingTag ? "#D97706" : T.border}`, background: draft.waitingTag ? "#FEF3C7" : "transparent", color: draft.waitingTag ? "#D97706" : T.textMuted, cursor: "pointer", transition: "all 0.12s" }}>
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.3"/><path d="M5 3v2.5l1.5 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
              En attente de retour
            </button>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setEditing(false)} style={{ padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 500, background: "transparent", border: `1px solid ${T.border}`, color: T.textSecondary, cursor: "pointer" }}>Annuler</button>
              <button onClick={commit} style={{ padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 700, background: T.accent, border: "none", color: "#fff", cursor: "pointer" }}>Enregistrer</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Read mode ──
  return (
    <div style={{ display: "flex", gap: 14 }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
        <div style={{ width: 9, height: 9, borderRadius: "50%", marginTop: 4, flexShrink: 0, background: cfg.color, border: `2px solid ${T.bgCard}`, boxShadow: `0 0 0 2px ${cfg.color}30` }} />
        {!isLast && <div style={{ width: 1.5, flex: 1, background: T.border, marginTop: 5 }} />}
      </div>
      <div style={{ paddingBottom: isLast ? 0 : 20, flex: 1 }}>
        {/* Header row */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.3, color: cfg.color, textTransform: "uppercase" }}>{cfg.label}</span>
          <span style={{ fontSize: 11, color: T.textMuted }}>{formatDate(entry.date)}</span>
          {/* Note indicator badge */}
          {hasNote && (
            <button onClick={() => setExpanded(v => !v)} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 7px", borderRadius: 10, fontSize: 10, fontWeight: 600, background: expanded ? `${cfg.color}18` : T.bgHover, border: `1px solid ${expanded ? cfg.color + "40" : T.border}`, color: expanded ? cfg.color : T.textMuted, cursor: "pointer", transition: "all 0.15s" }}>
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M1 1h7v5H5.5L4.5 8 3.5 6H1V1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
              Note
              <svg width="7" height="7" viewBox="0 0 7 7" fill="none" style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}><path d="M1 2l2.5 2.5L6 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
            </button>
          )}
          {hover && (
            <div style={{ marginLeft: hasNote ? 0 : "auto", display: "flex", gap: 4 }}>
              <button onClick={() => { setDraft({ type: entry.type, date: entry.date, text: entry.text, noteContent: entry.noteContent || "", waitingTag: entry.waitingTag || false }); setEditing(true); }} style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, padding: 2, opacity: 0.6, display: "flex", alignItems: "center" }} title="Modifier">
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M7.5 1.5l2 2-6 6H1.5v-2l6-6z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
              </button>
              {onDelete && (
                <button onClick={() => onDelete(entry.id)} style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, padding: 2, opacity: 0.6, display: "flex", alignItems: "center" }} title="Supprimer">
                  <IC.Trash />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Summary text */}
        <div style={{ fontSize: 13, color: T.textSecondary, lineHeight: 1.55 }}>{entry.text}</div>

        {/* Waiting tag */}
        {entry.waitingTag && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 5, padding: "2px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700, background: "#FEF3C7", color: "#D97706", border: "1px solid #D9770630" }}>
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.3"/><path d="M5 3v2.5l1.5 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
            En attente de retour
          </span>
        )}

        {/* Expanded note */}
        {hasNote && expanded && (
          <div style={{ marginTop: 10, padding: "12px 14px", background: `${cfg.color}08`, border: `1px solid ${cfg.color}20`, borderRadius: 8, borderLeft: `3px solid ${cfg.color}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: cfg.color, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 8 }}>Note complète</div>
            <div style={{ fontSize: 13, color: T.textSecondary, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{entry.noteContent}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── EDITABLE JIRA (multi-liens) ─────────────────────────────────────────────
function EditableJira({ jiraLinks, onChange }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState("");
  const inputRef = useRef();
  const editRef = useRef();

  useEffect(() => { if (adding && inputRef.current) inputRef.current.focus(); }, [adding]);
  useEffect(() => { if (editingId && editRef.current) editRef.current.focus(); }, [editingId]);

  function urlToKey(url) {
    return url.trim().split("/").pop().split("?")[0];
  }

  function addLink() {
    const url = draft.trim();
    if (!url) { setAdding(false); return; }
    const key = urlToKey(url);
    onChange([...jiraLinks, { id: `j${Date.now()}`, url, key }]);
    setDraft("");
    setAdding(false);
  }

  function updateLink(id) {
    const url = editDraft.trim();
    if (!url) { removeLink(id); return; }
    const key = urlToKey(url);
    onChange(jiraLinks.map(l => l.id === id ? { ...l, url, key } : l));
    setEditingId(null);
  }

  function removeLink(id) {
    onChange(jiraLinks.filter(l => l.id !== id));
    setEditingId(null);
  }

  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
      {jiraLinks.map(link => (
        editingId === link.id ? (
          <div key={link.id} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <IC.Jira />
            <input
              ref={editRef}
              value={editDraft}
              onChange={e => setEditDraft(e.target.value)}
              onBlur={() => updateLink(link.id)}
              onKeyDown={e => { if (e.key === "Enter") updateLink(link.id); if (e.key === "Escape") setEditingId(null); }}
              style={{ fontSize: 12, padding: "3px 8px", border: `1px solid ${T.accent}`, borderRadius: 6, outline: "none", fontFamily: "inherit", color: T.textPrimary, background: T.accentBg, width: 240 }}
            />
            <button onClick={() => removeLink(link.id)} title="Supprimer" style={{ background: "none", border: "none", cursor: "pointer", color: "#DC2626", padding: 2, display: "flex", alignItems: "center", opacity: 0.7 }}>
              <IC.X />
            </button>
          </div>
        ) : (
          <div key={link.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <a href={link.url} target="_blank" rel="noopener noreferrer" style={{ display: "flex", alignItems: "center", gap: 5, textDecoration: "none", color: T.accent, fontSize: 12, fontWeight: 600 }}>
              <IC.Jira />{link.key}<IC.Link />
            </a>
            <button onClick={() => { setEditingId(link.id); setEditDraft(link.url); }} title="Modifier" style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, padding: 2, opacity: 0.45, display: "flex", alignItems: "center" }}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M6.5 1.5l2 2-5 5H1.5v-2l5-5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
            </button>
          </div>
        )
      ))}

      {adding ? (
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <IC.Jira />
          <input
            ref={inputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={addLink}
            onKeyDown={e => { if (e.key === "Enter") addLink(); if (e.key === "Escape") { setDraft(""); setAdding(false); } }}
            placeholder="https://jira.tv.sfr.net/browse/…"
            style={{ fontSize: 12, padding: "3px 8px", border: `1px solid ${T.accent}`, borderRadius: 6, outline: "none", fontFamily: "inherit", color: T.textPrimary, background: T.accentBg, width: 260 }}
          />
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: T.textMuted, background: "none", border: `1px dashed ${T.border}`, borderRadius: 6, padding: "3px 9px", cursor: "pointer" }}>
          <IC.Plus />{jiraLinks.length === 0 && "Ajouter un lien Jira"}
        </button>
      )}
    </div>
  );
}

// ─── EDITABLE STAKEHOLDERS ────────────────────────────────────────────────────
function EditableStakeholders({ stakeholders, onChange }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(stakeholders.join(", "));
  const ref = useRef();

  useEffect(() => { setDraft(stakeholders.join(", ")); }, [stakeholders]);
  useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.select(); } }, [editing]);

  function commit() {
    const parsed = draft.split(",").map(s => s.trim()).filter(Boolean);
    onChange(parsed);
    setEditing(false);
  }

  if (editing) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <IC.User />
        <input
          ref={ref}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(stakeholders.join(", ")); setEditing(false); } }}
          placeholder="Sylvie, Asmaa…"
          style={{ fontSize: 12, padding: "3px 8px", border: `1px solid ${T.accent}`, borderRadius: 6, outline: "none", fontFamily: "inherit", color: T.textPrimary, background: T.accentBg, width: 200 }}
        />
      </div>
    );
  }

  if (stakeholders.length > 0) {
    return (
      <button onClick={() => setEditing(true)} title="Modifier les interlocuteurs" style={{ display: "flex", alignItems: "center", gap: 5, color: T.textSecondary, fontSize: 12, background: "none", border: "none", cursor: "pointer", padding: "3px 6px", borderRadius: 6, transition: "background 0.12s" }}
        onMouseEnter={e => e.currentTarget.style.background = T.bgHover}
        onMouseLeave={e => e.currentTarget.style.background = "none"}>
        <IC.User />{stakeholders.join(", ")}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ opacity: 0.4 }}><path d="M6.5 1.5l2 2-5 5H1.5v-2l5-5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
      </button>
    );
  }

  return (
    <button onClick={() => setEditing(true)} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 500, color: T.textMuted, background: "none", border: `1px dashed ${T.border}`, borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}>
      <IC.User />Ajouter un interlocuteur
    </button>
  );
}

// ─── CONFIRM MODAL ────────────────────────────────────────────────────────────
function ConfirmModal({ title, message, confirmLabel = "Supprimer", onConfirm, onCancel }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(15,22,35,0.45)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onCancel}>
      <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 14, padding: 24, width: 360, maxWidth: "90vw", boxShadow: "0 20px 60px rgba(0,0,0,0.16)" }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.textPrimary, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 13, color: T.textSecondary, lineHeight: 1.55, marginBottom: 24 }}>{message}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={{ padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500, background: T.bgInput, border: `1px solid ${T.border}`, color: T.textSecondary, cursor: "pointer" }}>
            Annuler
          </button>
          <button onClick={onConfirm} style={{ padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700, background: "#DC2626", border: "none", color: "#fff", cursor: "pointer" }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}


function SubjectDetail({ project, onUpdate, onDelete, onDeleteActivity, incomingSync, onSyncConsumed }) {
  const [showAddActivity, setShowAddActivity] = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const sorted = sortEntries(project.timeline);
  const platforms = Array.isArray(project.platforms) ? project.platforms : [];

  const patch = (changes) => onUpdate(project.id, changes);

  // Dernière entrée "en attente de retour"
  const lastWaiting = sorted.find(e => e.waitingTag);
  const waitingDays = lastWaiting
    ? Math.floor((Date.now() - new Date(lastWaiting.date)) / 86400000)
    : null;

  function waitingLabel(days) {
    if (days === 0) return "En attente depuis aujourd'hui";
    if (days === 1) return "En attente depuis hier";
    if (days < 7)  return `En attente depuis ${days} jours`;
    if (days < 30) return `En attente depuis ${Math.floor(days / 7)} sem.`;
    return `En attente depuis ${Math.floor(days / 30)} mois`;
  }

  function waitingColor(days) {
    if (days <= 3)  return { color: "#D97706", bg: "#FEF3C7", border: "#D9770630" };
    if (days <= 10) return { color: "#EA580C", bg: "#FFF7ED", border: "#EA580C30" };
    return { color: "#DC2626", bg: "#FEF2F2", border: "#DC262630" };
  }

  // ── AI suggest next action ──
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);

  async function suggestNextAction() {
    setAiLoading(true);
    setAiError(null);
    const history = sortEntries(project.timeline)
      .slice(0, 10)
      .map(e => `[${e.date}] ${ACTIVITY_TYPES[e.type]?.label || e.type}: ${e.text}`)
      .join("\n");
    try {
      const prompt = `Tu es un assistant Product Designer. Analyse cet historique de sujet et rédige UNE seule prochaine action concrète, courte et actionnnable (max 80 chars). Réponds uniquement avec le texte de l'action, sans ponctuation finale, sans guillemets.

Sujet: ${project.title}
Interlocuteurs: ${(project.stakeholders || []).join(", ") || "aucun"}
Statut: ${STATUS_CONFIG[project.status]?.label || project.status}
Prochaine action actuelle: ${project.nextAction || "non définie"}

Historique récent (du plus récent au plus ancien):
${history}`;
      const suggestion = await callAI(prompt, 150);
      if (suggestion) {
        patch({ nextAction: suggestion });
      } else {
        throw new Error("Réponse vide de l'IA");
      }
    } catch (e) {
      setAiError(e.message || String(e));
    } finally {
      setAiLoading(false);
    }
  }
  const jiraLinks = project.jiraLinks || (project.jiraUrl ? [{ id: "legacy", url: project.jiraUrl, key: project.jiraKey }] : []);
  const [syncState, setSyncState] = useState("idle");
  const [syncDismissed, setSyncDismissed] = useState(false);

  // ── SYNC QUEUE — mis à jour par Claude à chaque "sync GFR-XXXXX" ──
  const SYNC_QUEUE = {
    "GFR-15815": [
      {"type":"feedback","date":"2026-09-11","text":"Retour Sylvie — lien écran 2 lignes manquant, encarts player trop grands vs production, coquille audiodescription, tailles mobile paysage à tester","waitingTag":true,"createdAt":"2026-09-11T12:15:00.000Z"},
      {"type":"update","date":"2026-09-04","text":"Écrans player remis au propre tous breakpoints + écran sous-titres 2 lignes. Tailles : Desktop/Laptop S→20 M→25 L→32, Tablet/Mobile S→16 M→20 L→26","waitingTag":true,"createdAt":"2026-09-04T14:02:00.000Z"},
      {"type":"feedback","date":"2026-08-28","text":"Retour Sylvie — demande écran sous-titres sur 2 lignes et définition des 3 tailles","waitingTag":false,"createdAt":"2026-08-28T14:48:00.000Z"},
      {"type":"update","date":"2026-08-27","text":"Modifications effectuées, lien Figma partagé","waitingTag":false,"createdAt":"2026-08-27T17:18:00.000Z"},
      {"type":"feedback","date":"2026-08-26","text":"Retour Sylvie — garder même largeur encart paramètres audio/sous-titres entre les niveaux","waitingTag":false,"createdAt":"2026-08-26T10:10:00.000Z"},
      {"type":"update","date":"2026-08-20","text":"Proto player mis à jour fond plus noir. Settings v1 : 3 options contraste. Tailles à définir avec devs à la rentrée","waitingTag":false,"createdAt":"2026-08-20T11:17:00.000Z"},
      {"type":"feedback","date":"2026-07-31","text":"Retour Sylvie — 3 niveaux tailles + 3 styles contraste validés. Player piste 2, fond plus noir. Réglages avec radio boutons","waitingTag":false,"createdAt":"2026-07-31T16:08:00.000Z"},
      {"type":"design","date":"2026-07-23","text":"Benchmark style sous-titres player et réglages Web envoyé à Sylvie (PDF) avec analyse et recommandations","waitingTag":true,"createdAt":"2026-07-23T15:04:00.000Z"}
    ]
  };

  // Trouver les activités pour ce sujet via ses jiraKeys
  const allJiraKeys = [project.jiraKey, ...(project.jiraLinks || []).map(l => l.key)].filter(Boolean);
  const existingCreatedAts = new Set(project.timeline.map(e => e.createdAt).filter(Boolean));
  const existingTexts = new Set(project.timeline.map(e => e.text.toLowerCase().trim()));
  const pendingFromQueue = allJiraKeys.flatMap(k => SYNC_QUEUE[k] || []).filter(a =>
    !existingCreatedAts.has(a.createdAt) && !existingTexts.has(a.text.toLowerCase().trim())
  );

  const [syncPreview, setSyncPreview] = useState([]);
  const [syncSelected, setSyncSelected] = useState(new Set());

  // Vérifier si l'utilisateur a déjà ignoré ce panneau (stocké directement sur le sujet, fiable et synchrone)
  useEffect(() => {
    if (pendingFromQueue.length === 0) return;
    if (project.syncQueueDismissed) {
      setSyncDismissed(true);
      return;
    }
    setSyncPreview(pendingFromQueue);
    setSyncState("preview");
  }, [project.id, pendingFromQueue.length, project.syncQueueDismissed]);

  // Receive activities pushed via incomingSync
  useEffect(() => {
    if (incomingSync && incomingSync.projectId === project.id) {
      setSyncPreview(incomingSync.activities);
      setSyncSelected(new Set());
      setSyncState("preview");
      onSyncConsumed?.();
    }
  }, [incomingSync]);

  function dismissSync() {
    patch({ syncQueueDismissed: true });
    setSyncState("idle");
    setSyncPreview([]);
  }

  function cancelSync() {
    dismissSync();
  }

  async function confirmSync() {
    const toAdd = syncPreview.filter((_, i) => syncSelected.has(i)).map(activity => ({
      ...activity,
      id: `e${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: activity.createdAt || new Date().toISOString(),
    }));
    if (toAdd.length > 0) {
      const lastDate = toAdd.reduce((latest, a) => a.date > latest ? a.date : latest, project.lastActivity || "");
      patch({ timeline: [...project.timeline, ...toAdd], lastActivity: lastDate, syncQueueDismissed: true });
    } else {
      dismissSync();
    }
    setSyncState("idle");
    setSyncPreview([]);
    setSyncSelected(new Set());
  }

  // ── Message à envoyer (partagé avec le dashboard via la même clé de storage) ──
  const MSG_STORAGE_KEY = `relance-text-${project.id}`;
  const [genMessage, setGenMessage] = useState(null);
  const [genLoading, setGenLoading] = useState(false);
  const [genError, setGenError] = useState(null);
  const [genCopied, setGenCopied] = useState(false);
  const [genValidating, setGenValidating] = useState(false);
  const [genValidated, setGenValidated] = useState(false);
  const genSaveTimer = useRef(null);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const r = await window.storage.get(MSG_STORAGE_KEY);
        if (!cancelled && r && r.value) setGenMessage(r.value);
      } catch {}
    }
    init();
    return () => { cancelled = true; };
  }, [project.id]);

  function saveGenMessage(text) {
    clearTimeout(genSaveTimer.current);
    genSaveTimer.current = setTimeout(async () => {
      try {
        if (text && text.trim()) await window.storage.set(MSG_STORAGE_KEY, text);
        else await window.storage.delete(MSG_STORAGE_KEY).catch(() => {});
      } catch {}
    }, 500);
  }

  async function generateGenMessage() {
    setGenLoading(true);
    setGenError(null);
    const history = sortEntries(project.timeline)
      .slice(0, 12)
      .map(e => `[${e.date}] ${ACTIVITY_TYPES[e.type]?.label || e.type}: ${e.text}`)
      .join("\n");
    try {
      const prompt = `Tu es un Product Designer. Rédige un message court et professionnel à envoyer pour avancer sur ce sujet.

Sujet: ${project.title}
Interlocuteur(s): ${(project.stakeholders || []).join(", ") || "non précisé"}
Prochaine action: ${project.nextAction || "non définie"}
Statut: ${STATUS_CONFIG[project.status]?.label || project.status}

Historique récent:
${history}

Le message doit:
- Être court (3-4 lignes max)
- Être directement lié à la prochaine action à mener
- Être naturel et professionnel
- Ne pas inclure d'objet mail ni de formule de politesse finale

Réponds uniquement avec le corps du message, prêt à copier-coller.`;
      const text = await callAI(prompt, 300);
      if (text) {
        setGenMessage(text);
        saveGenMessage(text);
      } else {
        throw new Error("Réponse vide de l'IA");
      }
    } catch (e) {
      setGenError(e.message || String(e));
    } finally {
      setGenLoading(false);
    }
  }

  function copyGenMessage() {
    copyToClipboard(genMessage).then(ok => {
      if (ok) {
        setGenCopied(true);
        setTimeout(() => setGenCopied(false), 2000);
      } else {
        alert("La copie automatique a échoué. Sélectionne le texte manuellement (Cmd/Ctrl+A puis Cmd/Ctrl+C).");
      }
    });
  }

  async function validateGenMessage() {
    setGenValidating(true);
    let entryText = project.nextAction;
    let entryType = "update";
    try {
      const prompt = `Analyse ce message qui vient d'être envoyé et cette prochaine action prévue. Détermine le type d'activité le plus approprié pour l'historique du projet, et reformule au passé.

Message envoyé: "${genMessage || "(aucun message, se baser sur l'action)"}"
Action prévue: "${project.nextAction}"

Types possibles: "relance" (rappel à quelqu'un qui n'a pas répondu), "feedback" (retour ou question reçue), "validation" (demande de validation/go), "design" (envoi d'un livrable design/écrans), "action" (action interne ou call), "update" (mise à jour générale).

Réponds UNIQUEMENT avec un JSON valide, sans backticks: {"type": "...", "text": "reformulation courte au passé, max 100 chars, sans ponctuation finale ni guillemets"}`;
      const raw = await callAI(prompt, 150);
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      if (parsed.text) entryText = parsed.text;
      if (parsed.type && ACTIVITY_TYPES[parsed.type]) entryType = parsed.type;
    } catch {}
    const newEntry = {
      id: `e${Date.now()}`,
      type: entryType,
      date: today(),
      text: entryText,
      createdAt: new Date().toISOString(),
    };
    patch({ timeline: [...project.timeline, newEntry], lastActivity: newEntry.date, ...(project.status === "in_progress" && { status: "waiting" }) });
    try { await window.storage.delete(MSG_STORAGE_KEY); } catch {}
    setGenMessage(null);
    setGenValidating(false);
    setGenValidated(true);
    setTimeout(() => setGenValidated(false), 2000);
  }

  function addActivity(activity) {
    const newEntry = { 
      ...activity, 
      id: `e${Date.now()}`, 
      createdAt: activity.createdAt || new Date().toISOString()
    };
    patch({ timeline: [...project.timeline, newEntry], lastActivity: activity.date });
  }

  function deleteActivity(entryId) {
    onDeleteActivity?.(entryId);
    patch({ timeline: project.timeline.filter(e => e.id !== entryId) });
  }

  function editActivity(entryId, changes) {
    patch({ timeline: project.timeline.map(e => e.id === entryId ? { ...e, ...changes } : e) });
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      {/* Header */}
      <div style={{ padding: "24px 28px 18px", borderBottom: `1px solid ${T.border}`, flexShrink: 0, background: T.bgCard }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <PlatformSelector platforms={platforms} onChange={v => patch({ platforms: v })} />
              <StatusBadge value={project.status} onChange={v => patch({ status: v })} />
              <PriorityBadge value={project.priority} onChange={v => patch({ priority: v })} />
            </div>
            <EditableText
              value={project.title}
              onChange={v => patch({ title: v })}
              placeholder="Titre du ticket"
              style={{ fontSize: 20, fontWeight: 800, color: T.textPrimary, lineHeight: 1.25, letterSpacing: -0.3, display: "block", width: "100%" }}
            />
            <div style={{ marginTop: 6 }}>
              <EditableText
                value={project.description || ""}
                onChange={v => patch({ description: v })}
                placeholder="Ajouter une description…"
                multiline
                style={{ fontSize: 13, color: T.textSecondary, lineHeight: 1.55, display: "block", width: "100%" }}
              />
            </div>
          </div>
          <button onClick={() => setShowConfirmDelete(true)} title="Supprimer ce sujet" style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, padding: 4, opacity: 0.5, flexShrink: 0, marginTop: 4 }}>
            <IC.Trash />
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 14 }}>
          {/* Jira — multi-liens */}
          <EditableJira
            jiraLinks={jiraLinks}
            onChange={links => {
              patch({ jiraLinks: links, jiraUrl: links[0]?.url || null, jiraKey: links[0]?.key || null });
            }}
          />

          {/* Stakeholders — editable */}
          <EditableStakeholders stakeholders={project.stakeholders || []} onChange={v => patch({ stakeholders: v })} />

          {project.lastActivity && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, color: T.textMuted, fontSize: 12 }}>
              <IC.Clock />{timeAgo(project.lastActivity)}
            </div>
          )}
          <span style={{ fontSize: 9, color: T.border, userSelect: "all", fontFamily: "monospace" }} title="ID sujet">{project.id}</span>
        </div>

        {/* Waiting marker */}
        {waitingDays !== null && (
          <div style={{ marginTop: 12, display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 12px", borderRadius: 20, background: waitingColor(waitingDays).bg, border: `1.5px solid ${waitingColor(waitingDays).border}` }}>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" style={{ flexShrink: 0 }}>
              <circle cx="5.5" cy="5.5" r="4.5" stroke={waitingColor(waitingDays).color} strokeWidth="1.3"/>
              <path d="M5.5 3v3l2 1.2" stroke={waitingColor(waitingDays).color} strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
            <span style={{ fontSize: 11, fontWeight: 700, color: waitingColor(waitingDays).color }}>{waitingLabel(waitingDays)}</span>
          </div>
        )}

        {/* Next action */}
        <div style={{ marginTop: 14, padding: "10px 14px", background: T.accentBg, border: `1px solid ${T.accent}25`, borderRadius: 9 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: T.accent, letterSpacing: 0.5, textTransform: "uppercase" }}>Prochaine action</div>
              <button onClick={suggestNextAction} disabled={aiLoading} title="Suggérer avec l'IA" aria-label="Suggérer avec l'IA" style={{ width: 26, height: 26, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: T.accent, background: aiLoading ? T.textMuted : `${T.accent}18`, border: "none", borderRadius: 6, cursor: aiLoading ? "wait" : "pointer", opacity: aiLoading ? 0.7 : 1, transition: "all 0.15s" }}>
                {aiLoading ? (
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg>
                ) : (
                  <IC.Sparkle />
                )}
              </button>
            </div>
            <EditableText
              value={project.nextAction || ""}
              onChange={v => patch({ nextAction: v })}
              placeholder="Définir la prochaine action…"
              style={{ fontSize: 13, color: T.accentText, fontWeight: 500, display: "block", width: "100%" }}
            />
            {aiError && (
              <div style={{ marginTop: 6, fontSize: 11, color: "#DC2626", background: "#FEF2F2", border: "1px solid #DC262630", borderRadius: 6, padding: "5px 8px" }}>
                ⚠️ {aiError}
              </div>
            )}
          </div>
        </div>

        {/* Rédiger un message — bloc séparé */}
        <div style={{ marginTop: 10, padding: "10px 14px", background: "#F5F3FF", border: "1px solid #7C3AED25", borderRadius: 9 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#7C3AED", letterSpacing: 0.5, textTransform: "uppercase" }}>Message à envoyer</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {genMessage && (
                <button onClick={validateGenMessage} disabled={genValidating} title="Marquer comme fait et ajouter à l'historique" aria-label="Valider" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700, padding: "4px 10px", height: 26, background: genValidated ? "#DCFCE7" : T.bgHover, border: `1px solid ${genValidated ? "#16A34A40" : T.border}`, borderRadius: 6, cursor: genValidating ? "wait" : "pointer", color: genValidated ? "#16A34A" : T.textSecondary, transition: "all 0.2s", opacity: genValidating ? 0.6 : 1 }}>
                  {genValidating ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg> : genValidated ? "✓" : <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5l2.5 2.5 4.5-5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  {genValidating ? "Validation…" : genValidated ? "Ajouté" : "Valider"}
                </button>
              )}
              <button onClick={generateGenMessage} disabled={genLoading} title={genMessage ? "Régénérer le message" : "Rédiger un message"} aria-label={genMessage ? "Régénérer le message" : "Rédiger un message"} style={{ width: 26, height: 26, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#7C3AED", background: genLoading ? T.textMuted : "#7C3AED18", border: "none", borderRadius: 6, cursor: genLoading ? "wait" : "pointer", transition: "all 0.15s" }}>
                {genLoading ? (
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg>
                ) : (
                  <IC.Sparkle />
                )}
              </button>
            </div>
          </div>

          {!genMessage && !genLoading && (
            <div style={{ marginTop: 4, fontSize: 12, color: "#7C3AED99" }}>Aucun message pour le moment</div>
          )}

          {genError && !genLoading && (
            <div style={{ marginTop: 8, padding: "10px 12px", background: "#FEF2F2", border: "1px solid #DC262630", borderRadius: 8, fontSize: 11, color: "#DC2626" }}>
              ⚠️ {genError}
            </div>
          )}

          {genMessage && (
            <div style={{ marginTop: 8, padding: "12px 14px", background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 8, position: "relative" }}>
              <textarea
                value={genMessage}
                onChange={e => { setGenMessage(e.target.value); saveGenMessage(e.target.value); }}
                rows={Math.max(3, genMessage.split("\n").length)}
                style={{ width: "100%", boxSizing: "border-box", background: "transparent", border: "none", outline: "none", resize: "vertical", fontSize: 12, color: T.textSecondary, lineHeight: 1.7, fontFamily: "inherit", paddingRight: 32 }}
              />
              <button onClick={copyGenMessage} title="Copier" aria-label="Copier" style={{ position: "absolute", top: 10, right: 10, width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", background: genCopied ? "#DCFCE7" : T.bgCard, border: `1px solid ${genCopied ? "#16A34A40" : T.border}`, borderRadius: 5, cursor: "pointer", color: genCopied ? "#16A34A" : T.textMuted, transition: "all 0.2s" }}>
                {genCopied ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5l2.5 2.5 4.5-5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><rect x="5" y="5" width="7" height="7" rx="1.3" stroke="currentColor" strokeWidth="1.3"/><path d="M3.5 9V2.8A1 1 0 014.5 1.8h6.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Sync preview panel */}
      {syncState === "preview" && syncPreview.length > 0 && (
        <div style={{ margin: "12px 28px 0", background: "#EEF0FF", border: "1px solid #6366F140", borderRadius: 10, flexShrink: 0, display: "flex", flexDirection: "column", maxHeight: 300, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px 8px", flexShrink: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, display: "flex", alignItems: "center", gap: 5 }}><IC.Sparkle /> {syncPreview.length} activité{syncPreview.length > 1 ? "s" : ""} détectée{syncPreview.length > 1 ? "s" : ""}</div>
            <button onClick={cancelSync} style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, padding: 2 }}><IC.X /></button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "0 16px", scrollbarWidth: "thin" }}>
            {[...syncPreview]
              .map((a, i) => ({ ...a, _origIdx: i }))
              .sort((a, b) => {
                if (b.date !== a.date) return b.date.localeCompare(a.date);
                return (b.createdAt || "").localeCompare(a.createdAt || "");
              })
              .map((a) => {
              const i = a._origIdx;
              const cfg = ACTIVITY_TYPES[a.type] || ACTIVITY_TYPES.note;
              const checked = syncSelected.has(i);
              return (
                <label key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: "7px 8px", marginBottom: 4, background: checked ? T.bgCard : "transparent", borderRadius: 7, border: `1px solid ${checked ? T.accent + "30" : "transparent"}` }}>
                  <input type="checkbox" checked={checked} onChange={() => { const n = new Set(syncSelected); checked ? n.delete(i) : n.add(i); setSyncSelected(n); }} style={{ marginTop: 2, accentColor: T.accent, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 9, fontWeight: 800, color: cfg.color, textTransform: "uppercase", letterSpacing: 0.4 }}>{cfg.label}</span>
                      <span style={{ fontSize: 11, color: T.textMuted }}>{formatDate(a.date)}</span>
                      {a.waitingTag && <span style={{ fontSize: 9, fontWeight: 700, color: "#D97706", background: "#FEF3C7", padding: "1px 6px", borderRadius: 8 }}>Attente</span>}
                    </div>
                    <div style={{ fontSize: 12, color: T.textSecondary, lineHeight: 1.4 }}>{a.text}</div>
                  </div>
                </label>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", padding: "10px 16px", borderTop: `1px solid ${T.accent}20`, flexShrink: 0 }}>
            <button onClick={cancelSync} style={{ padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 500, background: "transparent", border: `1px solid ${T.border}`, color: T.textSecondary, cursor: "pointer" }}>Ignorer</button>
            <button onClick={confirmSync} disabled={syncSelected.size === 0} style={{ padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 700, background: T.accent, border: "none", color: "#fff", cursor: syncSelected.size === 0 ? "default" : "pointer", opacity: syncSelected.size === 0 ? 0.5 : 1 }}>
              Ajouter {syncSelected.size} activité{syncSelected.size > 1 ? "s" : ""}
            </button>
          </div>
        </div>
      )}

      {/* Timeline */}
      <div style={{ flex: 1, overflowY: "auto", padding: "22px 28px", background: T.bg, scrollbarWidth: "thin", scrollbarColor: `${T.border} transparent` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, letterSpacing: 0.5, textTransform: "uppercase" }}>
            Historique · {sorted.length} entrée{sorted.length > 1 ? "s" : ""}
          </div>
          <button onClick={() => setShowAddActivity(true)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 7, color: T.textSecondary, fontSize: 12, fontWeight: 600, cursor: "pointer", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <IC.Plus />Ajouter
          </button>
        </div>
        {sorted.length === 0
          ? <div style={{ textAlign: "center", color: T.textMuted, fontSize: 13, padding: "48px 0" }}>Aucune activité — ajoute la première</div>
          : sorted.map((e, i) => <TimelineEntry key={e.id} entry={e} isLast={i === sorted.length - 1} onDelete={deleteActivity} onEdit={(changes) => editActivity(e.id, changes)} />)
        }
      </div>

      {showAddActivity && <AddActivityModal project={project} onClose={() => setShowAddActivity(false)} onAdd={addActivity} />}
      {showConfirmDelete && (
        <ConfirmModal
          title="Supprimer ce sujet ?"
          message={`"${project.title}" sera définitivement supprimé avec tout son historique.`}
          confirmLabel="Supprimer"
          onConfirm={() => { setShowConfirmDelete(false); onDelete(project.id); }}
          onCancel={() => setShowConfirmDelete(false)}
        />
      )}
    </div>
  );
}

// ─── PROJECT CARD ─────────────────────────────────────────────────────────────
function SubjectCard({ project, isSelected, onClick }) {
  const status = STATUS_CONFIG[project.status] || STATUS_CONFIG.futur;
  const platforms = Array.isArray(project.platforms) ? project.platforms : [];
  const last = sortEntries(project.timeline)[0];
  return (
    <button onClick={onClick} style={{ width: "100%", textAlign: "left", padding: "10px 12px", background: isSelected ? T.bgSelected : "transparent", border: `1px solid ${isSelected ? T.accent + "40" : "transparent"}`, borderRadius: 8, cursor: "pointer", transition: "all 0.1s", outline: "none", marginBottom: 1 }}
      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = T.bgHover; }}
      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", marginBottom: 4 }}>
            {platforms.map(p => {
              const pc = PLATFORM_COLORS[p] || T.futur;
              return <span key={p} style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: pc, background: `${pc}12`, padding: "1px 5px", borderRadius: 3, flexShrink: 0 }}>{p}</span>;
            })}
            <span style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.title}</span>
            {project.priority && (() => { const pc = PRIORITY_CONFIG[project.priority]; return pc ? <span style={{ fontSize: 9, fontWeight: 800, color: pc.color, background: pc.bg, padding: "1px 5px", borderRadius: 3, flexShrink: 0 }}>{pc.label}</span> : null; })()}
          </div>
          {last && <div style={{ fontSize: 11, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{last.text}</div>}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
            {project.jiraKey && <span style={{ fontSize: 10, color: T.textMuted, fontFamily: "monospace" }}>{project.jiraKey}</span>}
            {project.stakeholders?.length > 0 && <span style={{ fontSize: 10, color: T.textMuted }}>{project.stakeholders.join(", ")}</span>}
          </div>
        </div>
        <div style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, marginTop: 5, background: status.color }} />
      </div>
    </button>
  );
}

// ─── PLACEHOLDER ──────────────────────────────────────────────────────────────
function PlaceholderPage({ label }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: T.textMuted }}>
      <div style={{ width: 48, height: 48, borderRadius: 14, background: T.bgHover, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>🚧</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.textSecondary }}>{label}</div>
      <div style={{ fontSize: 12, color: T.textMuted }}>Bientôt disponible</div>
    </div>
  );
}

// ─── PROJECTS PAGE ────────────────────────────────────────────────────────────
function SubjectsPage({ projects, onUpdate, onAdd, onDelete, onDeleteActivity, targetProjectId, onTargetConsumed, incomingSync, onSyncConsumed }) {
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("in_progress");
  const [filterPlatform, setFilterPlatform] = useState("all");
  const [showAddProject, setShowAddProject] = useState(false);

  const selected = projects.find(p => p.id === selectedId);

  // Auto-select first project
  useEffect(() => {
    if (!selectedId && projects.length > 0) setSelectedId(projects[0].id);
  }, [projects, selectedId]);

  // Navigate to target project from dashboard
  useEffect(() => {
    if (targetProjectId) {
      setSelectedId(targetProjectId);
      onTargetConsumed?.();
    }
  }, [targetProjectId]);

  // If selected got deleted
  useEffect(() => {
    if (selectedId && !projects.find(p => p.id === selectedId)) {
      setSelectedId(projects[0]?.id || null);
    }
  }, [projects, selectedId]);

  const availablePlatforms = useMemo(() => {
    const all = projects.flatMap(p => p.platforms || []);
    return [...new Set(all)].sort();
  }, [projects]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return projects.filter(p => {
      const pPlats = p.platforms || [];
      const matchQ = !q || p.title.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q) || p.jiraKey?.toLowerCase().includes(q) || (p.stakeholders || []).some(s => s.toLowerCase().includes(q));
      return matchQ && (filterStatus === "all" || p.status === filterStatus) && (filterPlatform === "all" || pPlats.includes(filterPlatform));
    });
  }, [projects, search, filterStatus, filterPlatform]);

  const sections = {
    in_progress: filtered.filter(p => p.status === "in_progress"),
    waiting:     filtered.filter(p => p.status === "waiting"),
    blocked:     filtered.filter(p => p.status === "blocked"),
    futur:       filtered.filter(p => p.status === "futur"),
    done:        filtered.filter(p => p.status === "done"),
  };
  const counts = Object.fromEntries(Object.entries(STATUS_CONFIG).map(([k]) => [k, projects.filter(p => p.status === k).length]));

  function renderSection(statusKey) {
    const items = sections[statusKey];
    const cfg = STATUS_CONFIG[statusKey];
    if (!items.length) return null;
    return (
      <div key={statusKey} style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: T.textMuted, padding: "8px 12px 4px", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: cfg.color, display: "inline-block" }} />
          {cfg.label}
          <span style={{ marginLeft: "auto", color: T.textXMuted }}>{items.length}</span>
        </div>
        {items.map(p => <SubjectCard key={p.id} project={p} isSelected={p.id === selectedId} onClick={() => {
          setSelectedId(p.id);
          window.storage.set("active-project", JSON.stringify({ id: p.id, title: p.title, jiraKey: p.jiraKey, jiraLinks: p.jiraLinks || [] })).catch(() => {});
        }} />)}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden", minWidth: 0 }}>
      {/* ── List sidebar ── */}
      <div style={{ width: 420, flexShrink: 0, background: T.bgSidebar, borderRight: `1px solid ${T.border}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "16px 14px 10px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: T.textPrimary, letterSpacing: -0.3 }}>Sujets</div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>{projects.length} sujets · {counts.in_progress} en cours</div>
            </div>
            <button onClick={() => setShowAddProject(true)} style={{ width: 28, height: 28, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", background: T.accent, border: "none", cursor: "pointer", color: "#fff", boxShadow: "0 2px 8px rgba(99,102,241,0.3)" }}>
              <IC.Plus />
            </button>
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 10 }}>
            {[{ key: "all", label: "Tous", count: projects.length }, { key: "in_progress", label: "En cours", count: counts.in_progress, color: T.inProgress }, { key: "waiting", label: "En attente", count: counts.waiting, color: T.waiting }, { key: "blocked", label: "Bloqué", count: counts.blocked, color: "#DC2626" }, { key: "futur", label: "Futur", count: counts.futur, color: T.futur }, { key: "done", label: "Terminé", count: counts.done, color: T.done }].map(f => {
              const active = filterStatus === f.key;
              const col = f.color || T.textSecondary;
              return <button key={f.key} onClick={() => setFilterStatus(f.key)} style={{ padding: "3px 9px", borderRadius: 20, fontSize: 11, fontWeight: 600, border: `1.5px solid ${active ? col : T.border}`, background: active ? col : "transparent", color: active ? "#fff" : T.textSecondary, cursor: "pointer", transition: "all 0.12s" }}>{f.label} <span style={{ opacity: 0.75 }}>{f.count}</span></button>;
            })}
          </div>
          <div style={{ position: "relative", marginBottom: 8 }}>
            <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: T.textMuted }}><IC.Search /></span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Rechercher…" style={{ width: "100%", boxSizing: "border-box", padding: "7px 28px 7px 30px", background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 8, color: T.textPrimary, fontSize: 12, outline: "none", fontFamily: "inherit" }} />
            {search && <button onClick={() => setSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2 }}><IC.X /></button>}
          </div>
          </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 8px 16px", scrollbarWidth: "thin", scrollbarColor: `${T.border} transparent` }}>
          {filtered.length === 0
            ? <div style={{ textAlign: "center", color: T.textMuted, fontSize: 13, padding: "48px 0" }}>Aucun résultat</div>
            : Object.keys(STATUS_CONFIG).map(k => renderSection(k))
          }
        </div>
      </div>

      {/* ── Detail ── */}
      <div style={{ flex: 1, overflow: "hidden", minWidth: 0 }}>
        {selected
          ? <SubjectDetail key={selected.id} project={selected} onUpdate={onUpdate} onDelete={(id) => { onDelete(id); }}
              onDeleteActivity={onDeleteActivity}
              incomingSync={incomingSync?.projectId === selected.id ? incomingSync : null}
              onSyncConsumed={onSyncConsumed} />
          : <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}><div style={{ fontSize: 40 }}>📋</div><div style={{ fontSize: 14, fontWeight: 700, color: T.textSecondary }}>Sélectionne un ticket</div><div style={{ fontSize: 12, color: T.textMuted }}>ou crée-en un nouveau</div></div>
        }
      </div>

      {showAddProject && <AddSubjectModal onClose={() => setShowAddProject(false)} onAdd={(p) => { onAdd(p); setSelectedId(p.id); }} />}
    </div>
  );
}

// ─── KANBAN PAGE ──────────────────────────────────────────────────────────────
const KANBAN_COLUMNS = [
  { key: "in_progress", label: "En cours" },
  { key: "waiting",     label: "En attente" },
  { key: "blocked",     label: "Bloqué" },
  { key: "futur",       label: "Futur" },
  { key: "done",        label: "Terminé" },
];

function KanbanCard({ project, onUpdate, isDragging }) {
  const platforms = Array.isArray(project.platforms) ? project.platforms : [];
  const lastEntry = sortEntries(project.timeline)[0];
  const lastWaiting = sortEntries(project.timeline).find(e => e.waitingTag);
  const waitingDays = lastWaiting ? Math.floor((Date.now() - new Date(lastWaiting.date)) / 86400000) : null;

  function waitingColor(days) {
    if (days <= 3)  return "#D97706";
    if (days <= 10) return "#EA580C";
    return "#DC2626";
  }

  return (
    <div style={{
      background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 10,
      padding: "12px 14px", marginBottom: 8, cursor: "grab",
      boxShadow: isDragging ? "0 8px 24px rgba(0,0,0,0.12)" : "0 1px 3px rgba(0,0,0,0.05)",
      opacity: isDragging ? 0.5 : 1, transition: "box-shadow 0.15s",
      userSelect: "none",
    }}>
      {/* Platform tags */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 7 }}>
        {platforms.map(p => {
          const pc = PLATFORM_COLORS[p] || T.futur;
          return <span key={p} style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: pc, background: `${pc}12`, padding: "1px 5px", borderRadius: 3 }}>{p}</span>;
        })}
      </div>

      {/* Title */}
      <div style={{ fontSize: 13, fontWeight: 700, color: T.textPrimary, lineHeight: 1.35, marginBottom: 6 }}>
        {project.title}
      </div>

      {/* Last activity */}
      {lastEntry && (
        <div style={{ fontSize: 11, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 8 }}>
          {lastEntry.text}
        </div>
      )}

      {/* Footer */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {project.jiraKey && (
          <span style={{ fontSize: 10, color: T.textMuted, fontFamily: "monospace" }}>{project.jiraKey}</span>
        )}
        {project.stakeholders?.length > 0 && (
          <span style={{ fontSize: 10, color: T.textMuted }}>{project.stakeholders.join(", ")}</span>
        )}
        {waitingDays !== null && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 700, color: waitingColor(waitingDays), marginLeft: "auto" }}>
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.3"/><path d="M5 3v2.5l1.5 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
            {waitingDays === 0 ? "Auj." : waitingDays === 1 ? "Hier" : waitingDays < 7 ? `${waitingDays}j` : waitingDays < 30 ? `${Math.floor(waitingDays / 7)}sem` : `${Math.floor(waitingDays / 30)}m`}
          </span>
        )}
      </div>

      {/* Next action */}
      {project.nextAction && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${T.border}`, display: "flex", alignItems: "flex-start", gap: 5 }}>
          <IC.Arrow />
          <span style={{ fontSize: 11, color: T.accentText, lineHeight: 1.4 }}>{project.nextAction}</span>
        </div>
      )}
    </div>
  );
}

function KanbanColumn({ column, projects, onDragStart, onDrop, dragOver, setDragOver }) {
  const cfg = STATUS_CONFIG[column.key];
  const count = projects.length;
  const isOver = dragOver === column.key;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}
      onDragOver={e => { e.preventDefault(); setDragOver(column.key); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(null); }}
      onDrop={e => { e.preventDefault(); setDragOver(null); onDrop(); }}
    >
      {/* Column header */}
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 2px 10px", flexShrink: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: cfg.color, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: T.textPrimary }}>{column.label}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, background: T.bgHover, borderRadius: 10, padding: "1px 7px" }}>{count}</span>
      </div>

      {/* Cards zone */}
      <div style={{
        flex: 1, overflowY: "auto", padding: "2px 2px 12px",
        background: isOver ? `${cfg.color}08` : "transparent",
        borderRadius: 10, border: `2px dashed ${isOver ? cfg.color + "40" : "transparent"}`,
        transition: "all 0.15s", minHeight: 60,
        scrollbarWidth: "thin", scrollbarColor: `${T.border} transparent`,
      }}>
        {count === 0 && !isOver && (
          <div style={{ textAlign: "center", color: T.textXMuted, fontSize: 12, padding: "24px 0" }}>Vide</div>
        )}
        {projects.map(p => (
          <div key={p.id} draggable onDragStart={() => onDragStart(p.id)}>
            <KanbanCard project={p} />
          </div>
        ))}
      </div>
    </div>
  );
}

function KanbanPage({ projects, onUpdate }) {
  const [dragOver, setDragOver] = useState(null);
  const [search, setSearch] = useState("");
  const dragId = useRef(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return projects;
    return projects.filter(p =>
      p.title.toLowerCase().includes(q) ||
      (p.stakeholders || []).some(s => s.toLowerCase().includes(q)) ||
      p.jiraKey?.toLowerCase().includes(q)
    );
  }, [projects, search]);

  function handleDrop(targetStatus) {
    if (!dragId.current) return;
    onUpdate(dragId.current, { status: targetStatus });
    dragId.current = null;
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
      {/* Header */}
      <div style={{ padding: "16px 24px 12px", borderBottom: `1px solid ${T.border}`, background: T.bgCard, flexShrink: 0, display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: T.textPrimary, letterSpacing: -0.3 }}>Kanban</div>
        <div style={{ fontSize: 11, color: T.textMuted }}>{projects.length} sujets</div>
        <div style={{ marginLeft: "auto", position: "relative" }}>
          <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: T.textMuted }}><IC.Search /></span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Rechercher…" style={{ padding: "6px 10px 6px 28px", background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12, color: T.textPrimary, outline: "none", fontFamily: "inherit", width: 200 }} />
        </div>
      </div>

      {/* Board */}
      <div style={{ flex: 1, overflow: "auto", padding: "20px 24px" }}>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${KANBAN_COLUMNS.length}, minmax(0, 1fr))`, gap: 12, height: "calc(100% - 0px)", minHeight: 0 }}>
          {KANBAN_COLUMNS.map(col => (
            <KanbanColumn
              key={col.key}
              column={col}
              projects={filtered.filter(p => p.status === col.key)}
              onDragStart={id => { dragId.current = id; }}
              onDrop={() => handleDrop(col.key)}
              dragOver={dragOver}
              setDragOver={setDragOver}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── NEXT ACTION ITEM ─────────────────────────────────────────────────────────
// ─── NEXT ACTION ITEM ─────────────────────────────────────────────────────────
function NextActionItem({ project, onNavigate, onUpdateProject, isLast }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [copied, setCopied] = useState(false);
  const [validated, setValidated] = useState(false);
  const [validating, setValidating] = useState(false);
  const cfg = STATUS_CONFIG[project.status];
  const platforms = project.platforms || [];
  const saveTimer = useRef(null);
  const STORAGE_KEY = `relance-text-${project.id}`;

  // Charger le texte sauvegardé s'il existe (pas de génération automatique)
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const r = await window.storage.get(STORAGE_KEY);
        if (!cancelled && r && r.value) {
          setMessage(r.value);
        }
      } catch {}
    }
    init();
    return () => { cancelled = true; };
  }, [project.id]);

  function saveMessage(text) {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        if (text && text.trim()) {
          await window.storage.set(STORAGE_KEY, text);
        } else {
          await window.storage.delete(STORAGE_KEY).catch(() => {});
        }
      } catch {}
    }, 500);
  }

  const [error, setError] = useState(null);

  async function generateMessage() {
    setLoading(true);
    setError(null);
    const history = sortEntries(project.timeline)
      .slice(0, 12)
      .map(e => `[${e.date}] ${ACTIVITY_TYPES[e.type]?.label || e.type}: ${e.text}`)
      .join("\n");
    try {
      const prompt = `Tu es un Product Designer. Rédige un message court et professionnel à envoyer pour avancer sur ce sujet.

Sujet: ${project.title}
Interlocuteur(s): ${(project.stakeholders || []).join(", ") || "non précisé"}
Prochaine action: ${project.nextAction || "non définie"}
Statut: ${STATUS_CONFIG[project.status]?.label || project.status}

Historique récent:
${history}

Le message doit:
- Être court (3-4 lignes max)
- Être directement lié à la prochaine action à mener
- Être naturel et professionnel
- Ne pas inclure d'objet mail ni de formule de politesse finale

Réponds uniquement avec le corps du message, prêt à copier-coller.`;
      const text = await callAI(prompt, 300);
      if (text) {
        setMessage(text);
        saveMessage(text);
      }
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }

  function copy() {
    copyToClipboard(message).then(ok => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        alert("La copie automatique a échoué. Sélectionne le texte manuellement (Cmd/Ctrl+A puis Cmd/Ctrl+C).");
      }
    });
  }

  async function validateAndLog() {
    setValidating(true);
    let entryText = project.nextAction;
    let entryType = "update";
    try {
      const prompt = `Analyse ce message qui vient d'être envoyé et cette prochaine action prévue. Détermine le type d'activité le plus approprié pour l'historique du projet, et reformule au passé.

Message envoyé: "${message || "(aucun message, se baser sur l'action)"}"
Action prévue: "${project.nextAction}"

Types possibles: "relance" (rappel à quelqu'un qui n'a pas répondu), "feedback" (retour ou question reçue), "validation" (demande de validation/go), "design" (envoi d'un livrable design/écrans), "action" (action interne ou call), "update" (mise à jour générale).

Réponds UNIQUEMENT avec un JSON valide, sans backticks: {"type": "...", "text": "reformulation courte au passé, max 100 chars, sans ponctuation finale ni guillemets"}`;
      const raw = await callAI(prompt, 150);
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      if (parsed.text) entryText = parsed.text;
      if (parsed.type && ACTIVITY_TYPES[parsed.type]) entryType = parsed.type;
    } catch (e) { /* fallback sur le texte original et type "update" si l'IA échoue */ }

    const newEntry = {
      id: `e${Date.now()}`,
      type: entryType,
      date: today(),
      text: entryText,
      createdAt: new Date().toISOString(),
    };
    onUpdateProject(project.id, {
      timeline: [...project.timeline, newEntry],
      lastActivity: newEntry.date,
      ...(project.status === "in_progress" && { status: "waiting" }),
    });
    try { await window.storage.delete(STORAGE_KEY); } catch {}
    setMessage(null);
    setValidating(false);
    setValidated(true);
    setTimeout(() => setValidated(false), 2000);
  }

  return (
    <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 16px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ marginTop: 3, flexShrink: 0 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: cfg.color, display: "inline-block" }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4, flexWrap: "wrap" }}>
            {project.priority && (() => { const pc = PRIORITY_CONFIG[project.priority]; return pc ? <span style={{ fontSize: 9, fontWeight: 800, color: pc.color, background: pc.bg, padding: "1px 6px", borderRadius: 3, letterSpacing: 0.4 }}>{pc.label}</span> : null; })()}
            {platforms.slice(0, 2).map(pl => {
              const pc = PLATFORM_COLORS[pl] || T.futur;
              return <span key={pl} style={{ fontSize: 9, fontWeight: 800, color: pc, background: `${pc}12`, padding: "1px 5px", borderRadius: 3, textTransform: "uppercase", letterSpacing: 0.4 }}>{pl}</span>;
            })}
            <span onClick={() => onNavigate("projects", project.id)} style={{ fontSize: 13, fontWeight: 700, color: T.textPrimary, cursor: "pointer" }}>{project.title}</span>
          </div>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 5, flex: 1, minWidth: 0 }}>
              <IC.Arrow />
              <span style={{ fontSize: 13, color: T.textSecondary, lineHeight: 1.5 }}>{project.nextAction}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              {message && (
                <button onClick={validateAndLog} disabled={validating} title="Marquer comme fait et ajouter à l'historique" aria-label="Valider" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700, padding: "4px 10px", background: validated ? "#DCFCE7" : T.bgHover, border: `1px solid ${validated ? "#16A34A40" : T.border}`, borderRadius: 6, cursor: validating ? "wait" : "pointer", color: validated ? "#16A34A" : T.textSecondary, transition: "all 0.2s", opacity: validating ? 0.6 : 1 }}>
                  {validating ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg> : validated ? "✓" : <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5l2.5 2.5 4.5-5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  {validating ? "Validation…" : validated ? "Ajouté" : "Valider"}
                </button>
              )}
              <button onClick={generateMessage} disabled={loading} title={loading ? "Rédaction…" : message ? "Régénérer" : "Rédiger"} aria-label={loading ? "Rédaction…" : message ? "Régénérer" : "Rédiger"} style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", background: loading ? T.textMuted : T.accent, border: "none", borderRadius: 6, cursor: loading ? "wait" : "pointer", transition: "all 0.15s", boxShadow: loading ? "none" : "0 2px 6px rgba(99,102,241,0.3)" }}>
                {loading ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg> : <IC.Sparkle />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {loading && !message && (
        <div style={{ marginTop: 10, padding: "12px 14px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="6" cy="6" r="4.5" stroke={T.accent} strokeWidth="1.6" strokeDasharray="18" strokeDashoffset="9"/></svg>
          <span style={{ fontSize: 12, color: T.textMuted }}>Rédaction du message…</span>
        </div>
      )}

      {error && !loading && (
        <div style={{ marginTop: 10, padding: "10px 12px", background: "#FEF2F2", border: "1px solid #DC262630", borderRadius: 8, fontSize: 11, color: "#DC2626" }}>
          ⚠️ {error}
        </div>
      )}

      {message && (
        <div style={{ marginTop: 10, padding: "12px 14px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, position: "relative" }}>
          <textarea
            value={message}
            onChange={e => { setMessage(e.target.value); saveMessage(e.target.value); }}
            rows={Math.max(3, message.split("\n").length)}
            style={{ width: "100%", boxSizing: "border-box", background: "transparent", border: "none", outline: "none", resize: "vertical", fontSize: 12, color: T.textSecondary, lineHeight: 1.7, fontFamily: "inherit", paddingRight: 32 }}
          />
          <button onClick={copy} title="Copier" aria-label="Copier" style={{ position: "absolute", top: 10, right: 10, width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", background: copied ? "#DCFCE7" : T.bgCard, border: `1px solid ${copied ? "#16A34A40" : T.border}`, borderRadius: 5, cursor: "pointer", color: copied ? "#16A34A" : T.textMuted, transition: "all 0.2s" }}>
            {copied ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5l2.5 2.5 4.5-5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><rect x="5" y="5" width="7" height="7" rx="1.3" stroke="currentColor" strokeWidth="1.3"/><path d="M3.5 9V2.8A1 1 0 014.5 1.8h6.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── RELANCE ITEM ─────────────────────────────────────────────────────────────
function RelanceItem({ project, days, waitingBadgeColor, onNavigate, onUpdateProject, isLast }) {
  const [loading, setLoading] = useState(false);
  const [relance, setRelance] = useState(null);
  const [copied, setCopied] = useState(false);
  const [validated, setValidated] = useState(false);
  const [validating, setValidating] = useState(false);
  const wc = waitingBadgeColor(days);
  const platforms = project.platforms || [];
  const saveTimer = useRef(null);
  const STORAGE_KEY = `waiting-message-${project.id}`;

  // Charger le texte sauvegardé s'il existe (pas de génération automatique)
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const r = await window.storage.get(STORAGE_KEY);
        if (!cancelled && r && r.value) {
          setRelance(r.value);
        }
      } catch {}
    }
    init();
    return () => { cancelled = true; };
  }, [project.id]);

  function saveRelance(text) {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        if (text && text.trim()) await window.storage.set(STORAGE_KEY, text);
        else await window.storage.delete(STORAGE_KEY).catch(() => {});
      } catch {}
    }, 500);
  }

  const [error, setError] = useState(null);

  async function generateRelance() {
    setLoading(true);
    setError(null);
    const history = sortEntries(project.timeline)
      .slice(0, 12)
      .map(e => `[${e.date}] ${ACTIVITY_TYPES[e.type]?.label || e.type}: ${e.text}`)
      .join("\n");
    const lastWaiting = sortEntries(project.timeline).find(e => e.waitingTag);
    try {
      const prompt = `Tu es un Product Designer. Rédige un message de relance court, professionnel et personnalisé à envoyer par mail ou Teams.

Sujet: ${project.title}
Interlocuteur(s): ${(project.stakeholders || []).join(", ") || "non précisé"}
En attente depuis: ${days === 0 ? "aujourd'hui" : days === 1 ? "hier" : `${days} jours`}
Dernière action en attente: ${lastWaiting?.text || "non précisée"}

Historique récent:
${history}

Le message doit:
- Être court (3-4 lignes max)
- Rappeler brièvement où on en est
- Demander poliment un retour
- Être direct et naturel, pas trop formel
- Ne pas inclure d'objet mail ni de formule de politesse finale

Réponds uniquement avec le corps du message, prêt à copier-coller.`;
      const text = await callAI(prompt, 300);
      if (text) { setRelance(text); saveRelance(text); }
      else throw new Error("Réponse vide de l'IA");
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  function copy() {
    copyToClipboard(relance).then(ok => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        alert("La copie automatique a échoué. Sélectionne le texte manuellement (Cmd/Ctrl+A puis Cmd/Ctrl+C).");
      }
    });
  }

  async function validateAndLog() {
    setValidating(true);
    const lastWaiting = sortEntries(project.timeline).find(e => e.waitingTag);
    let entryText = `Relance envoyée${lastWaiting ? ` — ${lastWaiting.text}` : ""}`;
    try {
      const prompt = `Rédige une courte entrée d'historique (max 100 chars, pas de ponctuation finale, pas de guillemets) qui décrit qu'une relance vient d'être envoyée sur ce point précis.

Point en attente: "${lastWaiting?.text || "non précisé"}"

Exemple: "Relance envoyée à Sylvie sur la validation des tailles". Réponds uniquement avec le texte.`;
      const reformulated = await callAI(prompt, 100);
      if (reformulated) entryText = reformulated;
    } catch (e) { /* fallback sur le texte par défaut si l'IA échoue */ }

    const newEntry = {
      id: `e${Date.now()}`,
      type: "relance",
      date: today(),
      text: entryText,
      createdAt: new Date().toISOString(),
    };
    onUpdateProject(project.id, {
      timeline: [...project.timeline, newEntry],
      lastActivity: newEntry.date,
      ...(project.status === "in_progress" && { status: "waiting" }),
    });
    try { await window.storage.delete(STORAGE_KEY); } catch {}
    setRelance(null);
    setValidating(false);
    setValidated(true);
    setTimeout(() => setValidated(false), 2000);
  }

  return (
    <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 16px" }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", marginBottom: 2 }}>
            {project.priority && (() => { const pc = PRIORITY_CONFIG[project.priority]; return pc ? <span style={{ fontSize: 9, fontWeight: 800, color: pc.color, background: pc.bg, padding: "1px 6px", borderRadius: 3, letterSpacing: 0.4 }}>{pc.label}</span> : null; })()}
            {platforms.slice(0, 2).map(pl => {
              const pc = PLATFORM_COLORS[pl] || T.futur;
              return <span key={pl} style={{ fontSize: 9, fontWeight: 800, color: pc, background: `${pc}12`, padding: "1px 5px", borderRadius: 3, textTransform: "uppercase", letterSpacing: 0.4 }}>{pl}</span>;
            })}
            <span onClick={() => onNavigate("projects", project.id)} style={{ fontSize: 12, fontWeight: 600, color: T.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}>{project.title}</span>
            {project.jiraKey && (
              <span style={{ fontSize: 10, color: T.textMuted, fontFamily: "monospace", flexShrink: 0 }}>{project.jiraKey}</span>
            )}
          </div>
          {project.stakeholders?.length > 0 && (
            <span style={{ fontSize: 11, color: T.textMuted }}>{project.stakeholders.join(", ")}</span>
          )}
        </div>
        <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: wc.color, background: wc.bg, padding: "2px 8px", borderRadius: 10, whiteSpace: "nowrap" }}>
          {days === 0 ? "Auj." : days === 1 ? "Hier" : days < 7 ? `${days}j` : days < 30 ? `${Math.floor(days / 7)} sem.` : `${Math.floor(days / 30)} mois`}
        </span>
        <button onClick={generateRelance} disabled={loading} title={loading ? "Rédaction…" : relance ? "Régénérer" : "Relancer"} aria-label={loading ? "Rédaction…" : relance ? "Régénérer" : "Relancer"} style={{ flexShrink: 0, width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", background: loading ? T.textMuted : T.accent, border: "none", borderRadius: 6, cursor: loading ? "wait" : "pointer", transition: "all 0.15s", boxShadow: loading ? "none" : "0 2px 6px rgba(99,102,241,0.3)" }}>
          {loading ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg> : <IC.Sparkle />}
        </button>
      </div>

      {loading && !relance && (
        <div style={{ marginTop: 10, padding: "12px 14px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="6" cy="6" r="4.5" stroke={T.accent} strokeWidth="1.6" strokeDasharray="18" strokeDashoffset="9"/></svg>
          <span style={{ fontSize: 12, color: T.textMuted }}>Rédaction du message…</span>
        </div>
      )}

      {error && !loading && (
        <div style={{ marginTop: 10, padding: "10px 12px", background: "#FEF2F2", border: "1px solid #DC262630", borderRadius: 8, fontSize: 11, color: "#DC2626" }}>
          ⚠️ {error}
        </div>
      )}

      {relance && (
        <div style={{ marginTop: 10, padding: "12px 14px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, position: "relative" }}>
          <textarea
            value={relance}
            onChange={e => { setRelance(e.target.value); saveRelance(e.target.value); }}
            rows={Math.max(3, relance.split("\n").length)}
            style={{ width: "100%", boxSizing: "border-box", background: "transparent", border: "none", outline: "none", resize: "vertical", fontSize: 12, color: T.textSecondary, lineHeight: 1.7, fontFamily: "inherit", paddingRight: 60 }}
          />
          <div style={{ position: "absolute", top: 10, right: 10, display: "flex", gap: 6 }}>
            <button onClick={validateAndLog} disabled={validating} title="Marquer comme envoyé et ajouter à l'historique" aria-label="Valider" style={{ width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", background: validated ? "#DCFCE7" : T.bgCard, border: `1px solid ${validated ? "#16A34A40" : T.border}`, borderRadius: 5, cursor: validating ? "wait" : "pointer", color: validated ? "#16A34A" : T.textMuted, transition: "all 0.2s", opacity: validating ? 0.6 : 1 }}>
              {validating ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg> : <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5l2.5 2.5 4.5-5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </button>
            <button onClick={copy} title="Copier" aria-label="Copier" style={{ width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", background: copied ? "#DCFCE7" : T.bgCard, border: `1px solid ${copied ? "#16A34A40" : T.border}`, borderRadius: 5, cursor: "pointer", color: copied ? "#16A34A" : T.textMuted, transition: "all 0.2s" }}>
              {copied ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5l2.5 2.5 4.5-5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><rect x="5" y="5" width="7" height="7" rx="1.3" stroke="currentColor" strokeWidth="1.3"/><path d="M3.5 9V2.8A1 1 0 014.5 1.8h6.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── DASHBOARD PAGE ───────────────────────────────────────────────────────────
// ─── ACTIVITY PAGE ────────────────────────────────────────────────────────────
// ─── AJOUT RAPIDE PAR SEMAINE : choisir un sujet, reprend son dernier commentaire ──
function AddToWeekPicker({ projects, weekStart, isCurrentWeek, onAdd, onClose }) {
  const sortedProjects = [...projects].sort((a, b) => a.title.localeCompare(b.title));
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(15,22,35,0.4)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 14, width: 840, maxWidth: "90vw", maxHeight: "70vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.14)", overflow: "hidden" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: `1px solid ${T.border}` }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: T.textPrimary }}>Choisir un sujet</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2, display: "flex" }}><IC.X /></button>
        </div>
        <div style={{ overflowY: "auto" }}>
          {sortedProjects.length === 0 ? (
            <div style={{ padding: 20, fontSize: 12, color: T.textMuted, textAlign: "center" }}>Tous les sujets sont déjà présents cette semaine</div>
          ) : sortedProjects.map(p => {
            const last = sortEntries(p.timeline)[0];
            return (
              <button key={p.id} onClick={() => onAdd(p, last)} style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 16px", background: "none", border: "none", borderBottom: `1px solid ${T.border}`, cursor: "pointer" }}
                onMouseEnter={ev => ev.currentTarget.style.background = T.bgHover}
                onMouseLeave={ev => ev.currentTarget.style.background = "transparent"}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: T.textPrimary }}>{p.title}</span>
                  {p.jiraKey && <span style={{ fontSize: 11, color: T.textMuted, fontFamily: "monospace" }}>{p.jiraKey}</span>}
                </div>
                <div style={{ fontSize: 12, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {last ? last.text : "Aucune activité existante"}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ActivityPage({ projects, onNavigate, onUpdateProject }) {
  const [expandedWeeks, setExpandedWeeks] = useState(null); // null = pas encore initialisé
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState(null); // { entry } à confirmer
  const [addPickerWeek, setAddPickerWeek] = useState(null); // weekStart pour lequel le sélecteur est ouvert

  function getWeekStart(dateStr) {
    const d = new Date(dateStr);
    const dow = d.getDay() === 0 ? 6 : d.getDay() - 1; // lundi = 0
    const monday = new Date(d);
    monday.setDate(d.getDate() - dow);
    monday.setHours(0, 0, 0, 0);
    return monday.toISOString().slice(0, 10);
  }
  const currentWeekStart = getWeekStart(today());

  const allEntries = useMemo(() => {
    return projects
      .flatMap(p => p.timeline.map(e => ({ ...e, project: p })))
      .filter(e => e.type !== "relance" && e.type !== "feedback")
      .sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        const tA = a.createdAt || a.id || "";
        const tB = b.createdAt || b.id || "";
        return tB.localeCompare(tA);
      });
  }, [projects]);

  const filtered = allEntries;

  const grouped = useMemo(() => {
    const groups = [];
    let currentWeek = null;
    for (const e of filtered) {
      const weekStart = getWeekStart(e.date);
      if (weekStart !== currentWeek) {
        currentWeek = weekStart;
        groups.push({ weekStart, entries: [], seenProjects: new Set() });
      }
      const group = groups[groups.length - 1];
      // Déduplication : une seule entrée par sujet et par semaine (la plus récente, déjà en tête grâce au tri)
      if (group.seenProjects.has(e.project.id)) continue;
      group.seenProjects.add(e.project.id);
      group.entries.push(e);
    }
    return groups;
  }, [filtered]);

  // Par défaut, seule la semaine actuelle est dépliée
  useEffect(() => {
    if (expandedWeeks === null && grouped.length > 0) {
      setExpandedWeeks(new Set([currentWeekStart]));
    }
  }, [grouped, expandedWeeks, currentWeekStart]);

  function toggleWeek(weekStart) {
    setExpandedWeeks(prev => {
      const next = new Set(prev || []);
      if (next.has(weekStart)) next.delete(weekStart);
      else next.add(weekStart);
      return next;
    });
  }

  function formatWeekLabel(weekStart) {
    const monday = new Date(weekStart);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    const thisMonday = new Date(getWeekStart(today()));
    const lastMonday = new Date(thisMonday); lastMonday.setDate(thisMonday.getDate() - 7);

    // Numéro de semaine calculé par rapport à la référence : semaine actuelle = 39
    const weeksDiff = Math.round((monday - thisMonday) / (7 * 24 * 60 * 60 * 1000));
    const weekNumber = 39 + weeksDiff;

    if (weekStart === thisMonday.toISOString().slice(0, 10)) return `Cette semaine · S${weekNumber}`;
    if (weekStart === lastMonday.toISOString().slice(0, 10)) return `Semaine dernière · S${weekNumber}`;
    const sameMonth = monday.getMonth() === sunday.getMonth();
    const startStr = monday.toLocaleDateString("fr-FR", { day: "numeric", month: sameMonth ? undefined : "short" });
    const endStr = sunday.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
    return `${startStr} — ${endStr}  ·  S${weekNumber}`;
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
      <div style={{ padding: "16px 24px 12px", borderBottom: `1px solid ${T.border}`, background: T.bgCard, flexShrink: 0, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: T.textPrimary, letterSpacing: -0.3 }}>Activité</div>
      </div>


      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", scrollbarWidth: "thin", scrollbarColor: `${T.border} transparent` }}>
        {grouped.length === 0 ? (
          <div style={{ textAlign: "center", color: T.textMuted, fontSize: 13, padding: "60px 0" }}>Aucune activité trouvée</div>
        ) : (
          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            {grouped.map((group, gi) => {
              const isExpanded = expandedWeeks?.has(group.weekStart);
              const totalDays = Math.min(5, group.entries.reduce((sum, e) => sum + (e.timeSpent || 0), 0));
              const pickerOpen = addPickerWeek === group.weekStart;
              return (
              <div key={group.weekStart} style={{ marginBottom: 24 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, paddingBottom: 6, borderBottom: `1px solid ${T.border}` }}>
                  <button onClick={() => toggleWeek(group.weekStart)} style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0, background: "none", border: "none", padding: 0, cursor: "pointer" }}>
                    <span style={{ display: "flex", alignItems: "center", color: T.textMuted, transform: isExpanded ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }}><IC.Chevron /></span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, letterSpacing: 0.4, textTransform: "uppercase" }}>
                      {formatWeekLabel(group.weekStart)}
                    </span>
                    <span style={{ fontSize: 10, color: T.textXMuted, fontWeight: 500 }}>· {group.entries.length}</span>
                  </button>
                  <span style={{ fontSize: 10, color: T.textMuted, fontWeight: 700, flexShrink: 0 }}>{totalDays} j</span>
                </div>
                {isExpanded && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {group.entries.map(e => {
                    const cfg = ACTIVITY_TYPES[e.type] || ACTIVITY_TYPES.note;
                    const platforms = e.project.platforms || [];
                    const timeSpent = e.timeSpent || 0;
                    const weekTotal = group.entries.reduce((sum, en) => sum + (en.timeSpent || 0), 0);
                    const atCap = weekTotal >= 5;

                    function adjustTime(delta) {
                      const weekTotal = group.entries.reduce((sum, en) => sum + (en.timeSpent || 0), 0);
                      if (delta > 0 && weekTotal >= 5) return; // Plafond de 5 jours par semaine
                      const next = Math.max(0, Math.round((timeSpent + delta) * 100) / 100);
                      onUpdateProject(e.project.id, {
                        timeline: e.project.timeline.map(te => te.id === e.id ? { ...te, timeSpent: next } : te),
                      });
                    }

                    return (
                      <div key={e.id} onClick={() => onNavigate("projects", e.project.id)} style={{ position: "relative", background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 12, padding: "10px 120px 10px 12px", cursor: "pointer" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: T.textPrimary }}>{e.project.title}</span>
                          {platforms.slice(0, 2).map(pl => {
                            const pc = PLATFORM_COLORS[pl] || T.futur;
                            return <span key={pl} style={{ fontSize: 9, fontWeight: 800, color: pc, background: `${pc}12`, padding: "1px 5px", borderRadius: 3, textTransform: "uppercase", letterSpacing: 0.4 }}>{pl}</span>;
                          })}
                          {e.project.jiraKey && <span style={{ fontSize: 10, color: T.textMuted, fontFamily: "monospace" }}>{e.project.jiraKey}</span>}
                          {e.waitingTag && <span style={{ fontSize: 9, fontWeight: 700, color: "#D97706", background: "#FEF3C7", padding: "1px 6px", borderRadius: 8 }}>Attente</span>}
                        </div>
                        <div style={{ fontSize: 12.5, color: T.textSecondary, lineHeight: 1.5 }}>
                          <span style={{ fontSize: 10, fontWeight: 800, color: cfg.color, textTransform: "uppercase", letterSpacing: 0.4, marginRight: 6 }}>{cfg.label}</span>
                          {e.text}
                        </div>
                        <div style={{ position: "absolute", top: "50%", right: 12, transform: "translateY(-50%)", display: "flex", alignItems: "center", gap: 6 }} onClick={ev => ev.stopPropagation()}>
                          <div style={{ display: "flex", alignItems: "center", gap: 4, background: T.bgHover, borderRadius: 999, padding: "3px 4px" }}>
                            <button onClick={() => adjustTime(-0.25)} aria-label="Retirer un quart de jour" style={{ width: 18, height: 18, borderRadius: "50%", border: "none", background: "transparent", color: T.textSecondary, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, transition: "background 0.12s, color 0.12s" }}
                              onMouseEnter={ev => { ev.currentTarget.style.background = T.bgCard; ev.currentTarget.style.color = T.textPrimary; }}
                              onMouseLeave={ev => { ev.currentTarget.style.background = "transparent"; ev.currentTarget.style.color = T.textSecondary; }}>
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 5h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
                            </button>
                            <span style={{ fontSize: 12, fontWeight: 700, color: T.textPrimary, minWidth: 18, textAlign: "center" }}>{timeSpent}</span>
                            <button onClick={() => adjustTime(0.25)} disabled={atCap} aria-label="Ajouter un quart de jour" title={atCap ? "Plafond de 5 jours atteint pour cette semaine" : "Ajouter un quart de jour"} style={{ width: 18, height: 18, borderRadius: "50%", border: "none", background: "transparent", color: atCap ? T.textXMuted : T.textSecondary, cursor: atCap ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, transition: "background 0.12s, color 0.12s" }}
                              onMouseEnter={ev => { if (!atCap) { ev.currentTarget.style.background = T.bgCard; ev.currentTarget.style.color = T.textPrimary; } }}
                              onMouseLeave={ev => { ev.currentTarget.style.background = "transparent"; ev.currentTarget.style.color = atCap ? T.textXMuted : T.textSecondary; }}>
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 1.5v7M1.5 5h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
                            </button>
                          </div>
                          <button
                            onClick={() => setConfirmDeleteEntry(e)}
                            aria-label="Supprimer cette activité"
                            title="Supprimer cette activité"
                            style={{ width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", borderRadius: "50%", color: T.textXMuted, cursor: "pointer", transition: "color 0.12s, background 0.12s" }}
                            onMouseEnter={ev => { ev.currentTarget.style.color = "#C5221F"; ev.currentTarget.style.background = "#FCE8E6"; }}
                            onMouseLeave={ev => { ev.currentTarget.style.color = T.textXMuted; ev.currentTarget.style.background = "transparent"; }}
                          >
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 3.5h7M4.5 3.5V2.3a.8.8 0 01.8-.8h1.4a.8.8 0 01.8.8v1.2M5 5.5v3M7 5.5v3M3.2 3.5l.4 6a1 1 0 001 .9h2.8a1 1 0 001-.9l.4-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  <button onClick={() => setAddPickerWeek(group.weekStart)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "10px 12px", background: "transparent", border: `1.5px dashed ${T.border}`, borderRadius: 12, cursor: "pointer", color: T.textMuted, fontSize: 12, fontWeight: 600 }}
                    onMouseEnter={ev => { ev.currentTarget.style.borderColor = T.accent; ev.currentTarget.style.color = T.accent; }}
                    onMouseLeave={ev => { ev.currentTarget.style.borderColor = T.border; ev.currentTarget.style.color = T.textMuted; }}>
                    <IC.Plus /> Ajouter un sujet
                  </button>

                  {pickerOpen && (
                    <AddToWeekPicker
                      projects={projects.filter(p => !group.entries.some(e => e.project.id === p.id))}
                      weekStart={group.weekStart}
                      isCurrentWeek={group.weekStart === currentWeekStart}
                      onClose={() => setAddPickerWeek(null)}
                      onAdd={(project, lastEntry) => {
                        const entryDate = group.weekStart === currentWeekStart ? today() : group.weekStart;
                        const newEntry = {
                          id: `e${Date.now()}`,
                          type: lastEntry?.type || "update",
                          date: entryDate,
                          text: lastEntry?.text || "",
                          createdAt: new Date().toISOString(),
                        };
                        onUpdateProject(project.id, {
                          timeline: [...project.timeline, newEntry],
                          lastActivity: entryDate > (project.lastActivity || "") ? entryDate : project.lastActivity,
                        });
                        setAddPickerWeek(null);
                      }}
                    />
                  )}
                </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>

      {confirmDeleteEntry && (
        <ConfirmModal
          title="Supprimer le ticket des activités de cette semaine ?"
          message={`${confirmDeleteEntry.project.title}${confirmDeleteEntry.project.jiraKey ? ` — ${confirmDeleteEntry.project.jiraKey}` : ""}`}
          confirmLabel="Supprimer"
          onCancel={() => setConfirmDeleteEntry(null)}
          onConfirm={() => {
            onUpdateProject(confirmDeleteEntry.project.id, {
              timeline: confirmDeleteEntry.project.timeline.filter(te => te.id !== confirmDeleteEntry.id),
            });
            setConfirmDeleteEntry(null);
          }}
        />
      )}
    </div>
  );
}

// ─── DASHBOARD PAGE ───────────────────────────────────────────────────────────
function DashboardPage({ projects, onNavigate, onUpdateProject }) {
  const [waitingCollapsed, setWaitingCollapsed] = useState(false);
  const now = new Date();

  // ── Stats ──
  const counts = Object.fromEntries(Object.keys(STATUS_CONFIG).map(k => [k, projects.filter(p => p.status === k).length]));
  const total = projects.length;

  // ── Waiting too long (last waitingTag > 7 days ago) ──
  const waiting = projects
    .map(p => {
      const last = sortEntries(p.timeline).find(e => e.waitingTag);
      if (!last) return null;
      const days = Math.floor((now - new Date(last.date)) / 86400000);
      return { project: p, days };
    })
    .filter(Boolean)
    .sort((a, b) => b.days - a.days);

  // ── Next actions (projects with nextAction, active) ──
  const nextActions = projects
    .filter(p => p.nextAction && p.nextAction.trim() && p.status === "in_progress")
    .sort((a, b) => {
      const priorityOrder = { p1: 0, p2: 1, p3: 2 };
      const pa = priorityOrder[a.priority] ?? 3;
      const pb = priorityOrder[b.priority] ?? 3;
      return pa - pb;
    });

  function waitingBadgeColor(days) {
    if (days <= 3)  return { color: "#D97706", bg: "#FEF3C7" };
    if (days <= 10) return { color: "#EA580C", bg: "#FFF7ED" };
    return { color: "#DC2626", bg: "#FEF2F2" };
  }

  const Card = ({ children, style = {} }) => (
    <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 12, padding: "18px 20px", ...style }}>
      {children}
    </div>
  );

  const SectionTitle = ({ children }) => (
    <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 14 }}>
      {children}
    </div>
  );

  const dayName = now.toLocaleDateString("fr-FR", { weekday: "long" });
  const dateLabel = now.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

  return (
    <div style={{ flex: 1, minWidth: 0, overflowY: "auto", overflowX: "hidden", background: T.bg, scrollbarWidth: "thin", scrollbarColor: `${T.border} transparent` }}>
      <div style={{ padding: "28px 32px 48px" }}>

        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: T.textPrimary, letterSpacing: -0.5, textTransform: "capitalize" }}>
            Bonjour 👋
          </div>
          <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>
            {dayName.charAt(0).toUpperCase() + dayName.slice(1)} {dateLabel}
          </div>
        </div>

        {/* ── Row 1 : Stat cards ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 24 }}>
          {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
            <Card key={key} style={{ padding: "14px 16px", cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: cfg.color, display: "inline-block" }} />
                <span style={{ fontSize: 24, fontWeight: 800, color: T.textPrimary }}>{counts[key] || 0}</span>
              </div>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary }}>{cfg.label}</div>
              <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2 }}>
                {total > 0 ? Math.round(((counts[key] || 0) / total) * 100) : 0}% du total
              </div>
            </Card>
          ))}
        </div>

        {/* ── Row 2 : Next actions + Waiting + Recent activity ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>

          {/* Prochaines actions */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 12 }}>
              Prochaines actions · {nextActions.length}
            </div>
            {nextActions.length === 0 ? (
              <div style={{ fontSize: 13, color: T.textMuted, textAlign: "center", padding: "20px 0" }}>Aucune action en attente 🎉</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {nextActions.map((p) => (
                  <NextActionItem key={p.id} project={p} onNavigate={onNavigate} onUpdateProject={onUpdateProject} isLast={true} />
                ))}
              </div>
            )}
          </div>

          {/* En attente */}
          <div>
            <button onClick={() => setWaitingCollapsed(v => !v)} style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", padding: 0, marginBottom: 12, cursor: "pointer" }}>
              <span style={{ display: "flex", alignItems: "center", color: T.textMuted, transform: waitingCollapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s" }}><IC.Chevron /></span>
              <span style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, letterSpacing: 0.6, textTransform: "uppercase" }}>
                En attente de retour · {waiting.length}
              </span>
            </button>
            {!waitingCollapsed && (
              waiting.length === 0 ? (
                <div style={{ fontSize: 13, color: T.textMuted, textAlign: "center", padding: "20px 0" }}>Aucune attente en cours 🎉</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {waiting.map(({ project: p, days }) => (
                    <RelanceItem key={p.id} project={p} days={days} waitingBadgeColor={waitingBadgeColor} onNavigate={onNavigate} onUpdateProject={onUpdateProject} isLast={true} />
                  ))}
                </div>
              )
            )}
          </div>

        </div>

      </div>
    </div>
  );
}

// ─── APP (with persistent storage) ───────────────────────────────────────────
export default function App() {
  const [projects, setProjects] = useState(null);
  const [activePage, setActivePage] = useState("dashboard");
  const [targetProjectId, setTargetProjectId] = useState(null);
  const [saveStatus, setSaveStatus] = useState("idle");
  const [incomingSync, setIncomingSync] = useState(null); // { projectId, activities }
  const syncPollRef = useRef(null);
  const saveTimer = useRef(null);

  // ── Global poll for incoming sync from Claude ──
  useEffect(() => {
    syncPollRef.current = setInterval(async () => {
      try {
        const result = await window.storage.get("sync-incoming");
        if (result && result.value) {
          await window.storage.delete("sync-incoming");
          const payload = JSON.parse(result.value);
          setIncomingSync(payload);
          setTargetProjectId(payload.projectId);
          setActivePage("projects");
        }
      } catch {}
    }, 2000);
    return () => clearInterval(syncPollRef.current);
  }, []);

  // ── Load from Airtable on mount ──
  const [airtableError, setAirtableError] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const [sujetRecords, activiteRecords] = await Promise.all([
          airtableListAll(AIRTABLE_TABLE_SUJET),
          airtableListAll(AIRTABLE_TABLE_ACTIVITE),
        ]);

        const projectsById = {};
        sujetRecords.forEach(r => { projectsById[r.id] = airtableFieldsToProject(r); });

        activiteRecords.forEach(r => {
          const linked = (r.fields || {})["Sujets"] || [];
          const activity = airtableFieldsToActivity(r);
          linked.forEach(sujetId => {
            if (projectsById[sujetId]) projectsById[sujetId].timeline.push(activity);
          });
        });

        Object.values(projectsById).forEach(p => { p.timeline = sortEntries(p.timeline, "asc"); });

        setProjects(Object.values(projectsById));
      } catch (e) {
        setAirtableError(e.message || String(e));
        setProjects([]);
      }
    }
    load();
  }, []);

  // ── Diff-based sync to Airtable : chaque champ modifié part vers la bonne table ──
  async function syncProjectChange(prevProject, id, changes) {
    try {
      const { timeline, ...projectChanges } = changes;
      if (Object.keys(projectChanges).length > 0) {
        const merged = { ...prevProject, ...projectChanges };
        await airtableUpdate(AIRTABLE_TABLE_SUJET, id, projectToAirtableFields(merged));
      }

      if (timeline) {
        const nextIds = new Set(timeline.map(e => e.id));

        for (const e of (prevProject.timeline || [])) {
          if (!nextIds.has(e.id)) {
            await airtableDelete(AIRTABLE_TABLE_ACTIVITE, e.id).catch(() => {});
          }
        }
        for (const e of timeline) {
          const prevEntry = (prevProject.timeline || []).find(pe => pe.id === e.id);
          if (!prevEntry) {
            const created = await airtableCreate(AIRTABLE_TABLE_ACTIVITE, activityToAirtableFields(e, id));
            setProjects(prev => prev.map(p => p.id === id
              ? { ...p, timeline: p.timeline.map(te => te.id === e.id ? { ...te, id: created.id, createdAt: created.createdTime } : te) }
              : p
            ));
          } else if (JSON.stringify(prevEntry) !== JSON.stringify(e)) {
            await airtableUpdate(AIRTABLE_TABLE_ACTIVITE, e.id, activityToAirtableFields(e, id));
          }
        }
      }
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 1500);
    } catch (e) {
      setAirtableError(e.message || String(e));
      setSaveStatus("error");
    }
  }


  // ── Actions ──
  function updateProject(id, changes) {
    const prevProject = projects.find(p => p.id === id);
    setProjects(prev => prev.map(p => p.id === id ? { ...p, ...changes } : p));
    if (prevProject) {
      setSaveStatus("saving");
      syncProjectChange(prevProject, id, changes);
    }
  }

  function deleteActivityGlobal(entryId) {
    // La suppression Airtable se fait déjà dans syncProjectChange via le diff de timeline.
  }

  async function addProject(project) {
    setSaveStatus("saving");
    try {
      const created = await airtableCreate(AIRTABLE_TABLE_SUJET, projectToAirtableFields(project));
      const newProject = { ...project, id: created.id, createdAt: created.createdTime, timeline: [] };
      setProjects(prev => [newProject, ...prev]);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 1500);
    } catch (e) {
      setAirtableError(e.message || String(e));
      setSaveStatus("error");
    }
  }

  async function deleteProject(id) {
    const project = projects.find(p => p.id === id);
    setProjects(prev => prev.filter(p => p.id !== id));
    setSaveStatus("saving");
    try {
      await Promise.all((project?.timeline || []).map(e => airtableDelete(AIRTABLE_TABLE_ACTIVITE, e.id).catch(() => {})));
      await airtableDelete(AIRTABLE_TABLE_SUJET, id);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 1500);
    } catch (e) {
      setAirtableError(e.message || String(e));
      setSaveStatus("error");
    }
  }

  // ── Loading state ──
  if (projects === null) {
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: T.bg, fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', sans-serif" }}>
        <div style={{ textAlign: "center", color: T.textMuted }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: T.accent, margin: "0 auto 16px", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 14V5l6-3 6 3v9" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round"/><path d="M6 18v-5h6v5" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round"/></svg>
          </div>
          <div style={{ fontSize: 13, color: T.textMuted }}>Chargement…</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif", color: T.textPrimary, overflow: "hidden" }}>

      {/* ── NAV RAIL ── */}
      <nav style={{ width: 64, flexShrink: 0, background: T.bgNav, borderRight: `1px solid ${T.borderNav}`, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 16, paddingBottom: 16, zIndex: 10 }}>
        {/* Logo */}
        <div style={{ width: 36, height: 36, borderRadius: 10, background: T.accent, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 28, flexShrink: 0, boxShadow: "0 4px 12px rgba(99,102,241,0.4)" }}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 14V5l6-3 6 3v9" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round"/><path d="M6 18v-5h6v5" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round"/></svg>
        </div>

        {/* Nav items */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, width: "100%" }}>
          {NAV_ITEMS.map(item => {
            const active = activePage === item.id;
            return (
              <button key={item.id} onClick={() => item.available && setActivePage(item.id)} title={item.label}
                style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, padding: "10px 0", border: "none", cursor: item.available ? "pointer" : "default", background: active ? "rgba(99,102,241,0.2)" : "transparent", color: active ? T.textNavActive : item.available ? T.textNav : "#3D4256", borderLeft: active ? `2px solid ${T.accent}` : "2px solid transparent", transition: "all 0.15s" }}
                onMouseEnter={e => { if (item.available && !active) e.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                {item.icon(active)}
                <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: 0.2 }}>{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* Export / Import */}

        <div style={{ marginBottom: 10, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <button
            onClick={() => {
              const jsonStr = JSON.stringify({ projects, exportedAt: new Date().toISOString() }, null, 2);
              const blob = new Blob([jsonStr], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `project-tracker-backup-${today()}.json`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }}
            title="Exporter toutes les données en JSON"
            style={{ width: 28, height: 28, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: `1px solid ${T.borderNav}`, cursor: "pointer", color: T.textNav }}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M7 9l-3-3M7 9l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 11v1.5a1 1 0 001 1h8a1 1 0 001-1V11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
          </button>
          <label
            title="Importer une sauvegarde JSON"
            style={{ width: 28, height: 28, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: `1px solid ${T.borderNav}`, cursor: "pointer", color: T.textNav }}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 9V1M7 1l-3 3M7 1l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 11v1.5a1 1 0 001 1h8a1 1 0 001-1V11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
            <input type="file" accept="application/json" style={{ display: "none" }} onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = async (ev) => {
                try {
                  const data = JSON.parse(ev.target.result);
                  if (Array.isArray(data.projects)) {
                    setSaveStatus("saving");
                    const imported = [];
                    for (const p of data.projects) {
                      const created = await airtableCreate(AIRTABLE_TABLE_SUJET, projectToAirtableFields(p));
                      const newTimeline = [];
                      for (const entry of (p.timeline || [])) {
                        const createdEntry = await airtableCreate(AIRTABLE_TABLE_ACTIVITE, activityToAirtableFields(entry, created.id));
                        newTimeline.push({ ...entry, id: createdEntry.id, createdAt: createdEntry.createdTime });
                      }
                      imported.push({ ...p, id: created.id, createdAt: created.createdTime, timeline: newTimeline });
                    }
                    setProjects(prev => [...imported, ...prev]);
                    setSaveStatus("saved");
                    setTimeout(() => setSaveStatus("idle"), 1500);
                    alert(`${imported.length} sujets importés avec succès dans Airtable.`);
                  } else {
                    alert("Fichier invalide : aucun tableau 'projects' trouvé.");
                  }
                } catch (err) {
                  alert("Erreur d'import : " + (err.message || err));
                  setSaveStatus("error");
                }
              };
              reader.readAsText(file);
              e.target.value = "";
            }} />
          </label>
        </div>

        {/* Save indicator */}
        <div style={{ marginBottom: 8, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
          <div style={{
            width: 7, height: 7, borderRadius: "50%",
            background: saveStatus === "saved" ? "#16A34A" : saveStatus === "saving" ? "#D97706" : saveStatus === "error" ? "#DC2626" : "#2A2E3D",
            transition: "background 0.3s"
          }} title={saveStatus === "saved" ? "Sauvegardé" : saveStatus === "saving" ? "Sauvegarde…" : saveStatus === "error" ? "Erreur de sauvegarde" : "Synchronisé"} />
        </div>
      </nav>

      {/* ── PAGE ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", background: T.bg, minWidth: 0 }}>
        {activePage === "projects"  && <SubjectsPage projects={projects} onUpdate={updateProject} onAdd={addProject} onDelete={deleteProject} onDeleteActivity={deleteActivityGlobal} targetProjectId={targetProjectId} onTargetConsumed={() => setTargetProjectId(null)} incomingSync={incomingSync} onSyncConsumed={() => setIncomingSync(null)} />}
        {activePage === "kanban"    && <KanbanPage projects={projects} onUpdate={updateProject} />}
        {activePage === "activity"  && <ActivityPage projects={projects} onUpdateProject={updateProject} onNavigate={(page, id) => { setTargetProjectId(id || null); setActivePage(page); }} />}
        {activePage === "dashboard" && <DashboardPage projects={projects} onUpdateProject={updateProject} onNavigate={(page, id) => { setTargetProjectId(id || null); setActivePage(page); }} />}
        {activePage === "settings"  && <PlaceholderPage label="Réglages" />}
      </div>
    </div>
  );
}
