import { useState, useMemo, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import { SignedIn, SignedOut, SignIn, UserButton, useUser } from "@clerk/clerk-react";

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
const AIRTABLE_TABLE_TEMPS = "Temps";
const AIRTABLE_TABLE_CLIENT = "Client";

const STATUS_TO_AT = { in_progress: "En cours", waiting: "En attente", blocked: "Bloqué", futur: "Futur", done: "Terminer" };
const AT_TO_STATUS = Object.fromEntries(Object.entries(STATUS_TO_AT).map(([k, v]) => [v, k]));

const PRIORITY_TO_AT = { p1: "P1", p2: "P2", p3: "P3" };
const AT_TO_PRIORITY = Object.fromEntries(Object.entries(PRIORITY_TO_AT).map(([k, v]) => [v, k]));

const TYPE_TO_AT = { design: "Design", relance: "Relance", feedback: "Feedback", validation: "Validation", update: "Update", action: "Action", note: "Note" };
const AT_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_AT).map(([k, v]) => [v, k]));

const PLATFORM_TO_AT = { TV: "TV", Web: "Web", Mobile: "Mobile", STB: "STB", "STB Less": "STBLess", STB7: "STB7", Connect: "Connect", Other: "Other" };
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

// Plusieurs enregistrements en une requête (10 maximum par requête chez Airtable)
async function airtableBatchUpdate(table, records) {
  for (let i = 0; i < records.length; i += 10) {
    await airtableRequest(table, "", { method: "PATCH", body: JSON.stringify({ records: records.slice(i, i + 10) }) });
  }
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
  if (p.figmaUrl) fields["Lien Figma"] = p.figmaUrl;
  if (typeof p.order === "number") fields["Ordre"] = p.order;
  if (p.lastActivity) fields["Dernière activité"] = p.lastActivity;
  if (p.clientId) fields["Client"] = [p.clientId];
  fields["Personnes"] = getAssignees(p);
  return fields;
}

// Clé modifiée dans l'interface → champ(s) Airtable correspondant(s).
// On n'envoie que ce qui a changé : un champ Airtable mal configuré ne bloque plus le reste.
const CHANGE_TO_AT_FIELDS = {
  title: ["Titre"], description: ["Description"], nextAction: ["Prochaine action"], stakeholders: ["Interlocuteur"],
  status: ["Statut"], priority: ["Priorité"], platforms: ["Plateforme"],
  jiraUrl: ["Lien Jira"], jiraKey: ["Clé Jira"], jiraLinks: ["Lien Jira", "Clé Jira"],
  figmaUrl: ["Lien Figma"], lastActivity: ["Dernière activité"], clientId: ["Client"],
  assignees: ["Personnes"], assignee: ["Personnes"], order: ["Ordre"],
};
function changedSujetFields(project, changedKeys) {
  const all = projectToAirtableFields(project);
  const out = {};
  for (const key of changedKeys) {
    for (const name of (CHANGE_TO_AT_FIELDS[key] || [])) {
      // Champ absent = valeur vidée dans l'interface → on vide aussi Airtable
      out[name] = name in all ? all[name] : null;
    }
  }
  return out;
}

function airtableFieldsToProject(record) {
  const f = record.fields || {};
  const platforms = (f["Plateforme"] || []).map(pl => AT_TO_PLATFORM[pl] || pl);
  const clientLinks = f["Client"] || [];
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
    figmaUrl: f["Lien Figma"] || null,
    order: typeof f["Ordre"] === "number" ? f["Ordre"] : undefined,
    jiraLinks: f["Lien Jira"] ? [{ id: "primary", url: f["Lien Jira"], key: f["Clé Jira"] || "" }] : [],
    lastActivity: f["Dernière activité"] || null,
    clientId: clientLinks[0] || null,
    assignees: Array.isArray(f["Personnes"]) ? f["Personnes"] : (f["Personnes"] ? [f["Personnes"]] : []),
    createdAt: record.createdTime,
    timeline: [],
  };
}

function activityToAirtableFields(entry, sujetRecordId) {
  const fields = {
    "Sujets": [sujetRecordId],
    "Texte": entry.text || "",
    "Date": String(entry.date || today()).slice(0, 10),
    "En attente de retour": !!entry.waitingTag,
    "Note complémentaire": entry.noteContent || "",
    // Liste à choix unique : jamais de chaîne vide, uniquement une option existante ou null
    "Créé par": ASSIGNEE_OPTIONS.includes(entry.createdBy) ? entry.createdBy : null,
    // Horodatage exact (ISO) : l'ordre des activités d'une même journée ne dépend plus de l'heure de création Airtable
    "Horodatage": entry.createdAt || new Date().toISOString(),
  };
  if (entry.type && TYPE_TO_AT[entry.type]) fields["Type"] = TYPE_TO_AT[entry.type];
  return fields;
}

function airtableFieldsToActivity(record) {
  const f = record.fields || {};
  return {
    id: record.id,
    type: AT_TO_TYPE[f["Type"]] || "note",
    date: String(f["Date"] || "").slice(0, 10),
    text: f["Texte"] || "",
    waitingTag: !!f["En attente de retour"],
    noteContent: f["Note complémentaire"] || "",
    createdBy: f["Créé par"] || null,
    createdAt: f["Horodatage"] || record.createdTime,
  };
}

function clientToAirtableFields(c) {
  return {
    "Nom": c.name || "",
    "Couleur": c.color || "",
    "Logo": c.logoDataUrl || "",
    "Archivé": !!c.archived,
  };
}

function airtableFieldsToClient(record) {
  const f = record.fields || {};
  return {
    id: record.id,
    name: f["Nom"] || "",
    color: f["Couleur"] || null,
    logoDataUrl: f["Logo"] || null,
    archived: !!f["Archivé"],
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
  // Palette « lavande » : fond clair légèrement teinté, surfaces blanches, un seul violet d'action
  bg:           "#F7F6FD",
  bgSidebar:    "#FFFFFF",
  bgCard:       "#FFFFFF",
  bgHover:      "#F3F0FD",
  bgInput:      "#FFFFFF",
  bgSelected:   "#F3EEFF",
  bgNav:        "#FFFFFF",
  border:       "#EAE8F4",
  borderNav:    "#EAE8F4",
  textPrimary:   "#1F1D36",
  textSecondary: "#55536F",
  textMuted:     "#8A87A8",
  textXMuted:    "#C4C1D9",
  textNav:       "#8A87A8",
  textNavActive: "#FFFFFF",
  accent:      "#7550E3",
  accentBg:    "#F0EBFF",
  accentText:  "#5A3BC2",
  inProgress: "#7550E3",
  waiting:    "#E08E1F",
  futur:      "#8A87A8",
  done:       "#2DA66A",
  // Typographie, ombres et arrondis
  font:        "'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  shadowCard:  "0 1px 2px rgba(66,40,160,0.04), 0 6px 20px rgba(66,40,160,0.06)",
  shadowHover: "0 2px 4px rgba(66,40,160,0.06), 0 10px 28px rgba(66,40,160,0.10)",
  shadowPop:   "0 14px 44px rgba(66,40,160,0.18)",
  radiusCard:  18,
  radiusInput: 14,
};

// Survol d'une carte : liseré violet léger + ombre un peu plus marquée (état « sélectionné » : liseré violet plein)
const cardHover = {
  onMouseEnter: e => { e.currentTarget.style.borderColor = "rgba(117,80,227,0.35)"; e.currentTarget.style.boxShadow = T.shadowHover; },
  onMouseLeave: e => { e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.boxShadow = T.shadowCard; },
};

const ACTIVITY_TYPES = {
  design:     { label: "Design",       color: "#7550E3" },
  relance:    { label: "Relance",      color: "#D97706" },
  feedback:   { label: "Retour",       color: "#0891B2" },
  validation: { label: "Validation",   color: "#16A34A" },
  update:     { label: "Mise à jour",  color: "#7C3AED" },
  action:     { label: "Action",       color: "#2563EB" },
  note:       { label: "Note",         color: "#6B7280" },
};

const STATUS_CONFIG = {
  in_progress: { label: "En cours",   color: "#7550E3", bg: "#F0EBFF" },
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
  STB7:       "#65A30D",
  Connect:    "#059669",
  Other:      "#D97706",
};
const ALL_PLATFORMS = Object.keys(PLATFORM_COLORS);
const ASSIGNEE_OPTIONS = ["Maxime", "Estelle", "Morgan"];
const ASSIGNEE_INFO = {
  Maxime:  { abbr: "Max", color: "#7550E3" },
  Estelle: { abbr: "E",   color: "#DB2777" },
  Morgan:  { abbr: "Mo",  color: "#16A34A" },
};

// Liste des personnes d'un sujet — compatible avec l'ancien format (une seule personne)
function getAssignees(p) {
  if (Array.isArray(p?.assignees)) return p.assignees;
  if (p?.assignee) return [p.assignee];
  return [];
}

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
// Date du jour selon le fuseau horaire local (et non UTC), au format YYYY-MM-DD
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
// Date la plus récente d'un historique d'activités (ou null s'il est vide)
const latestDate = (timeline) => (timeline || []).reduce((max, e) => (e.date && e.date > max ? e.date : max), "") || null;
// ── Ordre manuel des cartes du Kanban ──
// Une carte classée à la main porte un nombre "order" ; les cartes jamais classées viennent ensuite, dans leur ordre d'origine.
const byKanbanOrder = (list) => [
  ...list.filter(p => typeof p.order === "number").sort((a, b) => a.order - b.order),
  ...list.filter(p => typeof p.order !== "number"),
];
// Position "tout en haut" d'une colonne (nouveau sujet, ou changement de statut fait ailleurs que dans le Kanban)
const topOrderFor = (projects, status, excludeId) => {
  const orders = projects.filter(p => p.status === status && p.id !== excludeId && typeof p.order === "number").map(p => p.order);
  return orders.length ? Math.min(...orders) - 1000 : 0;
};
// Calcule les changements (statut + ordre) pour déposer la carte `id` dans la colonne `targetStatus`,
// juste avant la carte `beforeId` (ou en bas de colonne si beforeId est null). Renvoie { idSujet: { status?, order } }.
function planKanbanMove(projects, id, targetStatus, beforeId) {
  const moving = projects.find(p => p.id === id);
  if (!moving || beforeId === id) return {}; // déposée sur elle-même : rien à faire
  const fullColumn = byKanbanOrder(projects.filter(p => p.status === targetStatus));
  const origIdx = fullColumn.findIndex(p => p.id === id);
  const col = fullColumn.filter(p => p.id !== id);
  let idx = beforeId ? col.findIndex(p => p.id === beforeId) : col.length;
  if (idx < 0) idx = col.length;
  if (moving.status === targetStatus && origIdx === idx) return {}; // même place : rien à enregistrer
  const statusChange = moving.status !== targetStatus ? { status: targetStatus } : {};
  const prev = col[idx - 1], next = col[idx];
  if (col.every(p => typeof p.order === "number")) {
    let value = null;
    if (prev && next) { const mid = Math.floor((prev.order + next.order) / 2); if (mid > prev.order && mid < next.order) value = mid; }
    else if (prev) value = prev.order + 1000;
    else if (next) value = next.order - 1000;
    else value = 0;
    if (value !== null) return { [id]: { ...statusChange, order: value } }; // une seule carte à enregistrer
  }
  // Plus de place entre deux cartes, ou cartes jamais classées : on renumérote la colonne (1000, 2000, …)
  const reordered = [...col.slice(0, idx), moving, ...col.slice(idx)];
  const changes = {};
  reordered.forEach((p, i) => {
    const order = (i + 1) * 1000;
    if (p.order !== order || p.id === id) changes[p.id] = { ...(p.id === id ? statusChange : {}), order };
  });
  return changes;
}

// Client affiché à l'arrivée : toujours SFR. Repli : le premier client non archivé (si SFR n'existe plus ou est archivé).
const pickDefaultClient = (clients) =>
  (clients || []).find(c => !c.archived && String(c.name || "").trim().toLowerCase() === "sfr")
  || (clients || []).find(c => !c.archived)
  || (clients || [])[0];
function formatDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}
function timeAgo(d) {
  if (!d) return "";
  // Écart en jours calendaires locaux (une date "YYYY-MM-DD" est lue comme minuit local)
  const [y, m, dd] = String(d).slice(0, 10).split("-").map(Number);
  const now = new Date();
  const days = Math.max(0, Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(y, m - 1, dd)) / 86400000));
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
  Jira:    ({ size = 11 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M11.571 11.513H0a5.218 5.218 0 005.058 5.488l5.058 5.49v.01l5.059-5.49A5.218 5.218 0 0011.571 11.513zM23.143 0H11.572A5.218 5.218 0 0016.63 5.489l5.057 5.49v.01l5.057-5.49A5.218 5.218 0 0023.143 0z"/></svg>,
  Figma:   () => <svg width="11" height="11" viewBox="0 0 38 57" fill="none"><path d="M19 28.5a9.5 9.5 0 1119 0 9.5 9.5 0 01-19 0z" fill="#1ABCFE"/><path d="M0 47.5A9.5 9.5 0 019.5 38H19v9.5a9.5 9.5 0 11-19 0z" fill="#0ACF83"/><path d="M19 0v19h9.5a9.5 9.5 0 000-19H19z" fill="#FF7262"/><path d="M0 9.5A9.5 9.5 0 009.5 19H19V0H9.5A9.5 9.5 0 000 9.5z" fill="#F24E1E"/><path d="M0 28.5A9.5 9.5 0 009.5 38H19V19H9.5A9.5 9.5 0 000 28.5z" fill="#A259FF"/></svg>,
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
    <span data-platform-stamp={name} style={{ ...platformStampStyle(name, "lg"), gap: 4 }}>
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

// ─── BADGE NUMÉRO JIRA (GFR-…) : même aspect partout, bien visible ───────────────
const JIRA_BLUE = "#0052CC";
// Réglages de texte COMMUNS au badge Jira et aux stamps de plateforme : même police, même épaisseur, même espacement des lettres
const STAMP_TEXT = { fontFamily: "inherit", fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", lineHeight: 1.35 };
const JIRA_SIZES = { sm: { fs: 10, px: 5, py: 1, gap: 3 }, md: { fs: 11, px: 6, py: 1, gap: 3 }, lg: { fs: 12, px: 6, py: 0, gap: 5, h: 22 } };
function jiraBadgeStyle(size = "md") {
  const s = JIRA_SIZES[size] || JIRA_SIZES.md;
  return { display: "inline-flex", alignItems: "center", gap: s.gap, flexShrink: 0, ...STAMP_TEXT, fontSize: s.fs, whiteSpace: "nowrap", color: JIRA_BLUE, background: "rgba(0,82,204,0.09)", border: "1px solid rgba(0,82,204,0.20)", borderRadius: 8, padding: `${s.py}px ${s.px}px`, ...(s.h ? { height: s.h, boxSizing: "border-box" } : {}) };
}
function JiraKey({ value, size = "md", onClick, title }) {
  if (!value) return null;
  return (
    <span data-jira-key={value} onClick={onClick} title={title} style={{ ...jiraBadgeStyle(size), cursor: onClick ? "pointer" : "inherit" }}>
      {value}
    </span>
  );
}

// ─── STAMP PLATEFORME (STB, STB LESS, CONNECT, TV…) : exactement les mêmes dimensions que le badge Jira ──
// (bordure de 1 px transparente : invisible, mais elle garde la même hauteur que le badge Jira, qui a un liseré)
// Boîte commune de tous les stamps (plateforme, priorité, attente) : mêmes dimensions que le badge Jira
function stampBoxStyle(size = "md") {
  const s = JIRA_SIZES[size] || JIRA_SIZES.md;
  return { display: "inline-flex", alignItems: "center", flexShrink: 0, ...STAMP_TEXT, fontSize: s.fs, whiteSpace: "nowrap", border: "1px solid transparent", borderRadius: 8, padding: `${s.py}px ${s.px}px`, ...(s.h ? { height: s.h, boxSizing: "border-box" } : {}) };
}
function platformStampStyle(name, size = "md") {
  const pc = PLATFORM_COLORS[name] || T.futur;
  return { ...stampBoxStyle(size), color: pc, background: `${pc}12` };
}
function PlatformStamp({ name, size = "md" }) {
  return <span data-platform-stamp={name} style={platformStampStyle(name, size)}>{name}</span>;
}
function PriorityStamp({ priority, size = "md" }) {
  const pc = PRIORITY_CONFIG[priority];
  if (!pc) return null;
  return <span data-priority-stamp={priority} style={{ ...stampBoxStyle(size), color: pc.color, background: pc.bg }}>{pc.label}</span>;
}
// « Attente » : design volontairement différent des autres stamps (pastille arrondie + horloge), avec les couleurs de la
// pastille « En attente de retour » de l'historique d'un sujet. Même hauteur et mêmes réglages de texte que les autres stamps.
function WaitingStamp({ size = "md" }) {
  const icon = { sm: 8, md: 9, lg: 11 }[size] || 9;
  return (
    <span data-waiting-stamp="1" style={{ ...stampBoxStyle(size), gap: 3, borderRadius: 999, textTransform: "none", color: "#D97706", background: "#FEF3C7", border: "1px solid #D9770630" }}>
      <svg width={icon} height={icon} viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0 }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.4"/><path d="M5 2.8V5l1.5 1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
      Attente
    </span>
  );
}

// ─── PRIORITY BADGE ───────────────────────────────────────────────────────────
function PriorityBadge({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const cfg = PRIORITY_CONFIG[value];
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button data-priority-stamp={value || ""} onClick={() => setOpen(v => !v)} style={{ ...stampBoxStyle("lg"), color: cfg ? cfg.color : T.textMuted, background: cfg ? cfg.bg : T.bgHover, border: `1px solid ${cfg ? cfg.color + "30" : T.border}`, cursor: "pointer", gap: 4, textTransform: cfg ? "uppercase" : "none" }}>
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
function EditableText({ value, onChange, style = {}, multiline = false, placeholder = "", minRows = 3, enterToSave = false }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef();

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);

  const doneRef = useRef(false);
  useEffect(() => { if (editing) doneRef.current = false; }, [editing]);

  function commit() {
    if (doneRef.current) return;   // déjà enregistré (ex. Entrée puis perte de focus)
    doneRef.current = true;
    setEditing(false);
    if (draft.trim() !== value) onChange(draft.trim() || value);
  }

  if (!editing) {
    return (
      <span onClick={() => setEditing(true)} title="Cliquer pour modifier" style={{ cursor: "text", borderBottom: "1px dashed transparent", transition: "border-color 0.15s", whiteSpace: multiline ? "pre-wrap" : "normal", ...style }}
        onMouseEnter={e => e.currentTarget.style.borderBottomColor = T.border}
        onMouseLeave={e => e.currentTarget.style.borderBottomColor = "transparent"}>
        {value || <span style={{ color: T.textMuted, fontStyle: "italic" }}>{placeholder}</span>}
      </span>
    );
  }

  const sharedStyle = { border: `1px solid ${T.accent}`, borderRadius: 5, outline: "none", fontFamily: "inherit", background: T.accentBg, color: T.textPrimary, padding: "2px 6px", ...style, borderBottom: `1px solid ${T.accent}` };

  const area = (
    <textarea
      ref={ref}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === "Escape") { setDraft(value); setEditing(false); return; }
        // Entrée valide (si enterToSave) ; Maj + Entrée = retour à la ligne ; Cmd/Ctrl + Entrée valide toujours
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (enterToSave || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commit();
        }
      }}
      style={{ ...sharedStyle, resize: "vertical", width: "100%", boxSizing: "border-box" }}
      rows={Math.max(minRows, String(draft).split("\n").length)}
    />
  );

  return multiline
    ? (enterToSave
        ? <div style={{ width: "100%" }}>{area}<div style={{ fontSize: 10, color: T.textMuted, marginTop: 3 }}>Entrée pour valider · Maj + Entrée pour un retour à la ligne</div></div>
        : area)
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

  const inputStyle = { width: "100%", boxSizing: "border-box", minHeight: 46, padding: "11px 16px", background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: T.radiusInput, boxShadow: "0 1px 2px rgba(66,40,160,0.04)", color: T.textPrimary, fontSize: 14, fontWeight: 500, outline: "none", fontFamily: "inherit" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(31,29,54,0.40)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ background: T.bgCard, border: "none", borderRadius: 26, padding: 32, width: 440, maxWidth: "90vw", maxHeight: "88vh", overflowY: "auto", boxShadow: T.shadowPop }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.5, color: T.textPrimary }}>Ajouter une activité</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 4 }}><IC.X /></button>
        </div>
        <div style={{ fontSize: 13, fontWeight: 500, color: T.textMuted, marginBottom: 24 }}>{(project.platforms || []).join(", ")} · {project.title}</div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, display: "block", marginBottom: 8 }}>Type</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {Object.entries(ACTIVITY_TYPES).map(([key, cfg]) => (
              <button key={key} onClick={() => setType(key)} style={{ height: 34, padding: "0 14px", borderRadius: 999, fontSize: 13, fontWeight: 600, border: `1.5px solid ${type === key ? cfg.color : T.border}`, background: type === key ? cfg.color : "transparent", color: type === key ? "#fff" : T.textSecondary, cursor: "pointer", transition: "all 0.12s" }}>{cfg.label}</button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, display: "block", marginBottom: 8 }}>Date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, display: "block", marginBottom: 8 }}>Description courte</label>
          <textarea value={text} onChange={e => setText(e.target.value)} placeholder="Ex: Design v2 envoyé à Sylvie" rows={2} style={{ ...inputStyle, resize: "vertical" }} />
        </div>

        {!showNote ? (
          <button onClick={() => setShowNote(true)} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: T.textMuted, background: "none", border: `1px dashed ${T.border}`, borderRadius: 12, padding: "9px 10px", cursor: "pointer", marginBottom: 16 }}>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1 1h9v7H6.5L5.5 10 4.5 8H1V1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
            Ajouter une note complémentaire
          </button>
        ) : (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary }}>
                Note complémentaire <span style={{ color: T.textMuted, fontWeight: 400 }}>(masquée, dépliable)</span>
              </label>
              <button onClick={() => { setShowNote(false); setNoteContent(""); }} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2 }}><IC.X /></button>
            </div>
            <textarea value={noteContent} onChange={e => setNoteContent(e.target.value)} placeholder="Email reçu, commentaires Figma, compte-rendu, contexte détaillé…" rows={5} autoFocus style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }} />
          </div>
        )}

        {/* Waiting tag */}
        <div style={{ marginBottom: 20 }}>
          <button onClick={() => setWaitingTag(v => !v)} style={{ display: "inline-flex", alignItems: "center", gap: 7, height: 36, padding: "0 16px", borderRadius: 999, fontSize: 13, fontWeight: 700, border: `1.5px solid ${waitingTag ? "#D97706" : T.border}`, background: waitingTag ? "#FEF3C7" : "transparent", color: waitingTag ? "#D97706" : T.textMuted, cursor: "pointer", transition: "all 0.15s" }}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.3"/><path d="M5 3v2.5l1.5 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
            En attente de retour
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ height: 46, padding: "0 22px", borderRadius: 14, fontSize: 14, fontWeight: 600, background: T.bgInput, border: `1px solid ${T.border}`, color: T.textSecondary, cursor: "pointer" }}>Annuler</button>
          <button onClick={() => { if (!text.trim()) return; onAdd({ type, text: text.trim(), date, ...(noteContent.trim() && { noteContent: noteContent.trim() }), ...(waitingTag && { waitingTag: true }) }); onClose(); }} style={{ height: 46, padding: "0 24px", borderRadius: 14, fontSize: 14, fontWeight: 700, background: T.accent, border: "none", color: "#fff", cursor: "pointer", boxShadow: "0 8px 18px rgba(117,80,227,0.28)" }}>Ajouter</button>
        </div>
      </div>
    </div>
  );
}

// ─── MODAL: ADD PROJECT ───────────────────────────────────────────────────────
function AddSubjectModal({ onClose, onAdd }) {
  const { user } = useUser();
  const defaultAssignee = ASSIGNEE_OPTIONS.includes(user?.firstName) ? user.firstName : null;
  const [form, setForm] = useState({ title: "", platforms: [], status: "in_progress", jiraUrl: "", figmaUrl: "", stakeholders: "", description: "", nextAction: "", assignees: defaultAssignee ? [defaultAssignee] : [] });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const inputStyle = { width: "100%", boxSizing: "border-box", minHeight: 46, padding: "11px 16px", background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: T.radiusInput, boxShadow: "0 1px 2px rgba(66,40,160,0.04)", color: T.textPrimary, fontSize: 14, fontWeight: 500, outline: "none", fontFamily: "inherit" };
  const label = (t) => <label style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, display: "block", marginBottom: 8 }}>{t}</label>;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(31,29,54,0.40)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ background: T.bgCard, border: "none", borderRadius: 26, padding: 32, width: 460, maxWidth: "90vw", maxHeight: "85vh", overflowY: "auto", boxShadow: T.shadowPop }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.5, color: T.textPrimary }}>Nouveau ticket</div>
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
          <div>
            {label("Qui travaille dessus ?")}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {ASSIGNEE_OPTIONS.map(name => {
                const active = form.assignees.includes(name);
                const info = ASSIGNEE_INFO[name];
                return (
                  <button key={name} type="button" onClick={() => set("assignees", active ? form.assignees.filter(n => n !== name) : [...form.assignees, name])} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px 4px 4px", borderRadius: 20, border: `1.5px solid ${active ? (info?.color || T.textSecondary) : T.border}`, background: active ? `${info?.color || T.textSecondary}14` : "transparent", cursor: "pointer", fontSize: 12, fontWeight: active ? 700 : 500, color: T.textPrimary }}>
                    <span style={{ width: 20, height: 20, borderRadius: "50%", background: info?.color || T.textXMuted, color: "#fff", fontSize: 9, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {info?.abbr || name[0]}
                    </span>
                    {name}
                  </button>
                );
              })}
            </div>
          </div>
          <div>{label("Statut")}<select value={form.status} onChange={e => set("status", e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>{Object.entries(STATUS_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
          <div>{label("Lien Jira")}<input value={form.jiraUrl} onChange={e => set("jiraUrl", e.target.value)} placeholder="https://jira.tv.sfr.net/browse/…" style={inputStyle} /></div>
          <div>{label("Lien Figma")}<input value={form.figmaUrl} onChange={e => set("figmaUrl", e.target.value)} placeholder="https://www.figma.com/design/…" style={inputStyle} /></div>
          <div>{label("Parties prenantes (virgule)")}<input value={form.stakeholders} onChange={e => set("stakeholders", e.target.value)} placeholder="Sylvie, Asmaa…" style={inputStyle} /></div>
          <div>{label("Description")}<textarea value={form.description} onChange={e => set("description", e.target.value)} rows={2} style={{ ...inputStyle, resize: "vertical" }} /></div>
          <div>{label("Prochaine action")}<textarea value={form.nextAction} onChange={e => set("nextAction", e.target.value)} placeholder="Ex: Envoyer proposition design à Sylvie" rows={2} style={{ ...inputStyle, resize: "vertical" }} /></div>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 22 }}>
          <button onClick={onClose} style={{ height: 46, padding: "0 22px", borderRadius: 14, fontSize: 14, fontWeight: 600, background: T.bgInput, border: `1px solid ${T.border}`, color: T.textSecondary, cursor: "pointer" }}>Annuler</button>
          <button onClick={() => {
            if (!form.title.trim()) return;
            const jiraKey = form.jiraUrl ? form.jiraUrl.split("/").pop() : null;
            onAdd({ id: `p${Date.now()}`, ...form, jiraKey, jiraUrl: form.jiraUrl || null, figmaUrl: form.figmaUrl.trim() || null, stakeholders: form.stakeholders.split(",").map(s => s.trim()).filter(Boolean), tags: [], lastActivity: today(), timeline: [], createdAt: today() });
            onClose();
          }} style={{ height: 46, padding: "0 24px", borderRadius: 14, fontSize: 14, fontWeight: 700, background: T.accent, border: "none", color: "#fff", cursor: "pointer", boxShadow: "0 8px 18px rgba(117,80,227,0.28)" }}>Créer</button>
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
            <label style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, display: "block", marginBottom: 8 }}>Description courte</label>
            <textarea value={draft.text} onChange={e => setDraft(d => ({ ...d, text: e.target.value }))} rows={2} autoFocus onKeyDown={e => { if (e.key === "Escape") setEditing(false); }} style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 6, color: T.textPrimary, fontSize: 13, outline: "none", fontFamily: "inherit", resize: "vertical" }} />
          </div>
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, display: "block", marginBottom: 8 }}>Note complémentaire <span style={{ color: T.textXMuted, fontWeight: 400 }}>(masquée, dépliable)</span></label>
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
          <span style={{ fontSize: 12, fontWeight: 700, color: cfg.color }}>{cfg.label}</span>
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
            /* Boutons modifier / supprimer : toujours à la suite du titre, de la date et de la pastille « Note »
               (marges verticales négatives : la hauteur de la ligne ne change pas au survol) */
            <div data-entry-actions style={{ display: "flex", alignItems: "center", gap: 4, margin: "-6px 0 -6px 2px" }}>
              <button data-entry-edit onClick={() => { setDraft({ type: entry.type, date: entry.date, text: entry.text, noteContent: entry.noteContent || "", waitingTag: entry.waitingTag || false }); setEditing(true); }} title="Modifier" aria-label="Modifier"
                style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 8, cursor: "pointer", background: T.accentBg, color: T.accent, transition: "background 0.12s, color 0.12s" }}
                onMouseEnter={e => { e.currentTarget.style.background = T.accent; e.currentTarget.style.color = "#fff"; }}
                onMouseLeave={e => { e.currentTarget.style.background = T.accentBg; e.currentTarget.style.color = T.accent; }}>
                <svg width="12" height="12" viewBox="0 0 11 11" fill="none"><path d="M7.5 1.5l2 2-6 6H1.5v-2l6-6z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
              </button>
              {onDelete && (
                <button data-entry-delete onClick={() => onDelete(entry.id)} title="Supprimer" aria-label="Supprimer"
                  style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 8, cursor: "pointer", background: "#FEF0F0", color: "#DC2626", transition: "background 0.12s, color 0.12s" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "#DC2626"; e.currentTarget.style.color = "#fff"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "#FEF0F0"; e.currentTarget.style.color = "#DC2626"; }}>
                  <IC.Trash />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Summary text */}
        <div style={{ fontSize: 13, color: T.textSecondary, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{entry.text}</div>

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
            <a data-jira-key={link.key} href={link.url} target="_blank" rel="noopener noreferrer" title="Ouvrir dans Jira" style={{ ...jiraBadgeStyle("lg"), textDecoration: "none" }}>
              {link.key}
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
        <button onClick={() => setAdding(true)} style={{ display: "flex", alignItems: "center", gap: 4, height: 22, boxSizing: "border-box", fontSize: 11, fontWeight: 600, color: T.textMuted, background: "none", border: `1px dashed ${T.border}`, borderRadius: 6, padding: "0 9px", cursor: "pointer" }}>
          <IC.Plus />{jiraLinks.length === 0 && "Ajouter un lien Jira"}
        </button>
      )}
    </div>
  );
}

// ─── EDITABLE STAKEHOLDERS ────────────────────────────────────────────────────
function EditableFigma({ figmaUrl, onChange }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(figmaUrl || "");
  const ref = useRef();

  useEffect(() => { setDraft(figmaUrl || ""); }, [figmaUrl]);
  useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.select(); } }, [editing]);

  function commit() {
    const url = draft.trim();
    onChange(url || null);
    setEditing(false);
  }

  if (editing) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <IC.Figma />
        <input
          ref={ref}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(figmaUrl || ""); setEditing(false); } }}
          placeholder="https://www.figma.com/design/…"
          style={{ fontSize: 12, padding: "3px 8px", border: `1px solid ${T.accent}`, borderRadius: 6, outline: "none", fontFamily: "inherit", color: T.textPrimary, background: T.accentBg, width: 260 }}
        />
      </div>
    );
  }

  if (figmaUrl) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <a href={figmaUrl} target="_blank" rel="noopener noreferrer" style={{ display: "flex", alignItems: "center", gap: 5, textDecoration: "none", color: T.accent, fontSize: 12, fontWeight: 600 }}>
          <IC.Figma />Figma<IC.Link />
        </a>
        <button onClick={() => setEditing(true)} title="Modifier le lien Figma" style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, padding: 2, opacity: 0.45, display: "flex", alignItems: "center" }}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M6.5 1.5l2 2-5 5H1.5v-2l5-5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
        </button>
      </div>
    );
  }

  return (
    <button onClick={() => setEditing(true)} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 500, color: T.textMuted, background: "none", border: `1px dashed ${T.border}`, borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}>
      <IC.Figma />Lien Figma
    </button>
  );
}

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

function PersonFilterDropdown({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const info = ASSIGNEE_INFO[value];

  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen(v => !v)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", boxSizing: "border-box", height: 46, padding: "0 14px", background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: T.radiusInput, boxShadow: "0 1px 2px rgba(66,40,160,0.04)", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
        {value === "all" ? (
          <span style={{ width: 20, height: 20, borderRadius: "50%", background: T.textXMuted, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><IC.User /></span>
        ) : (
          <span style={{ width: 20, height: 20, borderRadius: "50%", background: info?.color || T.accent, color: "#fff", fontSize: 9, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{info?.abbr || value[0]}</span>
        )}
        <span style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, flex: 1 }}>{value === "all" ? "Tout le monde" : value}</span>
        <span style={{ display: "flex", color: T.textMuted, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}><IC.Chevron /></span>
      </button>

      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
          <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 41, background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 16, boxShadow: T.shadowPop, overflow: "hidden", padding: 6 }}>
            <button onClick={() => { onChange("all"); setOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", background: value === "all" ? T.bgSelected : "transparent", border: "none", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 600, color: T.textPrimary, textAlign: "left", fontFamily: "inherit" }}>
              <span style={{ width: 20, height: 20, borderRadius: "50%", background: T.textXMuted, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><IC.User /></span>
              Tout le monde
            </button>
            {ASSIGNEE_OPTIONS.map(name => {
              const i = ASSIGNEE_INFO[name];
              return (
                <button key={name} onClick={() => { onChange(name); setOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", background: value === name ? T.bgSelected : "transparent", border: "none", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 600, color: T.textPrimary, textAlign: "left", fontFamily: "inherit" }}>
                  <span style={{ width: 20, height: 20, borderRadius: "50%", background: i?.color || T.accent, color: "#fff", fontSize: 9, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i?.abbr || name[0]}</span>
                  {name}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Filtre par personne, présélectionné sur l'utilisateur connecté (Clerk) ──
function useAssigneeFilter() {
  const { user, isLoaded } = useUser();
  const me = ASSIGNEE_OPTIONS.includes(user?.firstName) ? user.firstName : null;
  const [value, setValue] = useState(me || "all");
  const initialized = useRef(!!me);
  useEffect(() => {
    // Si le profil Clerk arrive après le premier affichage, on applique la présélection une seule fois
    if (!initialized.current && isLoaded) {
      initialized.current = true;
      if (me) setValue(me);
    }
  }, [isLoaded, me]);
  return [value, setValue];
}

function EditableAssignees({ assignees, onChange }) {
  const [open, setOpen] = useState(false);
  const list = assignees || [];

  function toggle(name) {
    onChange(list.includes(name) ? list.filter(n => n !== name) : [...list, name]);
  }

  return (
    <div style={{ position: "relative" }}>
      {list.length > 0 ? (
        <button onClick={() => setOpen(v => !v)} title="Modifier qui travaille sur ce sujet" style={{ display: "flex", alignItems: "center", gap: 6, color: T.textSecondary, fontSize: 12, background: "none", border: "none", cursor: "pointer", padding: "3px 6px", borderRadius: 6, transition: "background 0.12s" }}
          onMouseEnter={e => e.currentTarget.style.background = T.bgHover}
          onMouseLeave={e => e.currentTarget.style.background = "none"}>
          <span style={{ display: "flex" }}>
            {list.map((name, i) => {
              const info = ASSIGNEE_INFO[name];
              return (
                <span key={name} style={{ width: 22, height: 22, boxSizing: "border-box", borderRadius: "50%", border: `2px solid ${T.bgCard}`, marginLeft: i === 0 ? 0 : -7, background: info?.color || T.accent, color: "#fff", fontSize: 8, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {info?.abbr || name[0]}
                </span>
              );
            })}
          </span>
          {list.join(", ")}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ opacity: 0.4 }}><path d="M6.5 1.5l2 2-5 5H1.5v-2l5-5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
        </button>
      ) : (
        <button onClick={() => setOpen(true)} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 500, color: T.textMuted, background: "none", border: `1px dashed ${T.border}`, borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}>
          <IC.User />Qui travaille dessus ?
        </button>
      )}

      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
          <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 41, minWidth: 190, background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 10, boxShadow: "0 10px 30px rgba(0,0,0,0.14)", padding: 6 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.4, padding: "4px 8px 6px" }}>Qui travaille dessus ?</div>
            {ASSIGNEE_OPTIONS.map(name => {
              const info = ASSIGNEE_INFO[name];
              const active = list.includes(name);
              return (
                <button key={name} onClick={() => toggle(name)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 8px", background: active ? T.bgSelected : "transparent", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, color: T.textPrimary, textAlign: "left" }}>
                  <span style={{ width: 20, height: 20, borderRadius: "50%", background: info?.color || T.accent, color: "#fff", fontSize: 9, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{info?.abbr || name[0]}</span>
                  <span style={{ flex: 1, fontWeight: active ? 700 : 500 }}>{name}</span>
                  {active && <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5l2.5 2.5 4.5-5.5" stroke={T.accent} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── CONFIRM MODAL ────────────────────────────────────────────────────────────
function ConfirmModal({ title, message, confirmLabel = "Supprimer", onConfirm, onCancel }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(31,29,54,0.40)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onCancel}>
      <div style={{ background: T.bgCard, border: "none", borderRadius: 26, padding: 32, width: 360, maxWidth: "90vw", boxShadow: T.shadowPop }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.textPrimary, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 13, color: T.textSecondary, lineHeight: 1.55, marginBottom: 24 }}>{message}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={{ height: 46, padding: "0 22px", borderRadius: 14, fontSize: 14, fontWeight: 600, background: T.bgInput, border: `1px solid ${T.border}`, color: T.textSecondary, cursor: "pointer" }}>
            Annuler
          </button>
          <button onClick={onConfirm} style={{ height: 46, padding: "0 24px", borderRadius: 14, fontSize: 14, fontWeight: 700, background: "#DC2626", border: "none", color: "#fff", cursor: "pointer", boxShadow: "0 8px 18px rgba(220,38,38,0.25)" }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}


function SubjectDetail({ project, onUpdate, onDelete, onDeleteActivity, incomingSync, onSyncConsumed }) {
  const { user } = useUser();
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
      createdAt: activity.createdAt || new Date().toISOString(),
      createdBy: user?.firstName || null,
    };
    const nextTimeline = [...project.timeline, newEntry];
    patch({ timeline: nextTimeline, lastActivity: latestDate(nextTimeline) });
  }

  function deleteActivity(entryId) {
    onDeleteActivity?.(entryId);
    const nextTimeline = project.timeline.filter(e => e.id !== entryId);
    patch({ timeline: nextTimeline, lastActivity: latestDate(nextTimeline) });
  }

  function editActivity(entryId, changes) {
    const nextTimeline = project.timeline.map(e => e.id === entryId ? { ...e, ...changes } : e);
    patch({ timeline: nextTimeline, lastActivity: latestDate(nextTimeline) });
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      {/* Header */}
      <div style={{ padding: "15px 17px 12px", borderBottom: `1px solid ${T.border}`, flexShrink: 0, background: T.bgCard }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
              <PlatformSelector platforms={platforms} onChange={v => patch({ platforms: v })} />
              <StatusBadge value={project.status} onChange={v => patch({ status: v })} />
              <PriorityBadge value={project.priority} onChange={v => patch({ priority: v })} />
            </div>
            <EditableText
              value={project.title}
              onChange={v => patch({ title: v })}
              placeholder="Titre du ticket"
              style={{ fontSize: 26, fontWeight: 800, color: T.textPrimary, lineHeight: 1.2, letterSpacing: -0.7, display: "block", width: "100%" }}
            />
            <div style={{ marginTop: 6 }}>
              <EditableText
                value={project.description || ""}
                onChange={v => patch({ description: v })}
                placeholder="Ajouter une description…"
                multiline
                style={{ fontSize: 14, fontWeight: 500, color: T.textSecondary, lineHeight: 1.6, display: "block", width: "100%" }}
              />
            </div>
          </div>
          <button onClick={() => setShowConfirmDelete(true)} title="Supprimer ce sujet" style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, padding: 4, opacity: 0.5, flexShrink: 0, marginTop: 4 }}>
            <IC.Trash />
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 18 }}>
          {/* Jira — multi-liens */}
          <EditableJira
            jiraLinks={jiraLinks}
            onChange={links => {
              patch({ jiraLinks: links, jiraUrl: links[0]?.url || null, jiraKey: links[0]?.key || null });
            }}
          />

          {/* Figma — lien de maquette */}
          <EditableFigma figmaUrl={project.figmaUrl || null} onChange={v => patch({ figmaUrl: v })} />

          {/* Stakeholders — editable */}
          <EditableStakeholders stakeholders={project.stakeholders || []} onChange={v => patch({ stakeholders: v })} />

          {/* Assignees — qui travaille dessus */}
          <EditableAssignees assignees={getAssignees(project)} onChange={v => patch({ assignees: v, assignee: null })} />

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
        <div data-detail-box="next" style={{ marginTop: 22, padding: 12, background: "#EEE9FC", border: "1px solid #DCD1F8", borderRadius: 22 }}>
          {/* Rangée : colonne de texte (titre + description, en vertical) | bouton IA à droite, sur toute la hauteur du texte (52 px au minimum) */}
          <div style={{ display: "flex", alignItems: "stretch", gap: 12 }}>
            <div data-box-text style={{ flex: 1, minWidth: 0, paddingLeft: 5 }}>
              <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3, letterSpacing: 0.5, textTransform: "uppercase", color: "#8E6CEB", marginBottom: 6 }}>Prochaine action</div>
              <EditableText
              value={project.nextAction || ""}
              onChange={v => patch({ nextAction: v })}
              placeholder="Définir la prochaine action…"
              multiline
              enterToSave
              minRows={2}
              style={{ fontSize: 15, color: "#3D2C8D", fontWeight: 600, lineHeight: 1.55, display: "block", width: "100%" }}
            />
            </div>
            <div data-box-actions style={{ display: "flex", alignItems: "stretch", gap: 8, flexShrink: 0 }}>
              <button onClick={suggestNextAction} disabled={aiLoading} title="Suggérer avec l'IA" aria-label="Suggérer avec l'IA" style={{ width: 52, minHeight: 52, alignSelf: "stretch", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: T.accent, background: "#E5DDFB", border: "none", borderRadius: 16, cursor: aiLoading ? "wait" : "pointer", opacity: aiLoading ? 0.7 : 1, transition: "background 0.15s" }}
                onMouseEnter={e => { e.currentTarget.style.background = "#DBD0FA"; }} onMouseLeave={e => { e.currentTarget.style.background = "#E5DDFB"; }}>
                {aiLoading ? (
                  <svg width="16" height="16" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg>
                ) : (
                  <span style={{ display: "flex", transform: "scale(1.6)" }}><IC.Sparkle /></span>
                )}
              </button>
            </div>
          </div>
          {aiError && (
              <div style={{ marginTop: 10, fontSize: 12, color: "#DC2626", background: "#FEF2F2", border: "1px solid #DC262630", borderRadius: 10, padding: "6px 10px" }}>
                ⚠️ {aiError}
              </div>
            )}
        </div>

        {/* Rédiger un message — bloc séparé */}
        <div data-detail-box="message" style={{ marginTop: 12, padding: 12, background: "#F6F3FE", border: "1px solid #E4DCF8", borderRadius: 22 }}>
          {/* Rangée du haut : titre (et texte d'attente) | bouton à droite (✨ sans message, ✓ « Valider » avec un message) */}
          <div style={{ display: "flex", alignItems: genMessage ? "center" : "flex-start", gap: 12 }}>
            <div data-box-text style={{ flex: 1, minWidth: 0, paddingLeft: 5 }}>
              <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3, letterSpacing: 0.5, textTransform: "uppercase", color: "#8E6CEB" }}>Message à envoyer</div>
              {!genMessage && !genLoading && (
                <div style={{ marginTop: 6, fontSize: 15, fontWeight: 500, lineHeight: 1.55, color: "#A992EE" }}>Aucun message pour le moment</div>
              )}
            </div>
            <div data-box-actions style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              {genMessage ? (
                <button onClick={validateGenMessage} disabled={genValidating} title={genValidated ? "Ajouté à l'historique" : "Valider : marquer comme fait et ajouter à l'historique"} aria-label="Valider" data-validate-button style={{ width: 52, height: 40, flexShrink: 0, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", background: genValidated ? "#DCFCE7" : "#E9F7EF", border: "1px solid #2DA66A40", borderRadius: 14, cursor: genValidating ? "wait" : "pointer", color: "#1F8A55", transition: "background 0.15s, border-color 0.15s", opacity: genValidating ? 0.6 : 1 }}
                  onMouseEnter={e => { if (!genValidated) { e.currentTarget.style.background = "#2DA66A"; e.currentTarget.style.borderColor = "#2DA66A"; e.currentTarget.style.color = "#fff"; } }}
                  onMouseLeave={e => { if (!genValidated) { e.currentTarget.style.background = "#E9F7EF"; e.currentTarget.style.borderColor = "#2DA66A40"; e.currentTarget.style.color = "#1F8A55"; } }}>
                  {genValidating
                    ? <svg width="16" height="16" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg>
                    : <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4.5 10.5l3.5 3.5 7.5-8.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                </button>
              ) : (
                <button onClick={generateGenMessage} disabled={genLoading} title="Rédiger un message" aria-label="Rédiger un message" style={{ width: 52, height: 52, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: T.accent, background: "#E5DDFB", border: "none", borderRadius: 16, cursor: genLoading ? "wait" : "pointer", transition: "background 0.15s" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "#DBD0FA"; }} onMouseLeave={e => { e.currentTarget.style.background = "#E5DDFB"; }}>
                  {genLoading ? (
                    <svg width="16" height="16" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg>
                  ) : (
                    <span style={{ display: "flex", transform: "scale(1.6)" }}><IC.Sparkle /></span>
                  )}
                </button>
              )}
            </div>
          </div>

          {genError && !genLoading && (
            <div style={{ marginTop: 10, padding: "8px 12px", background: "#FEF2F2", border: "1px solid #DC262630", borderRadius: 10, fontSize: 12, color: "#DC2626" }}>
              ⚠️ {genError}
            </div>
          )}

          {genMessage && (
            /* Rangée du bas : le message (pleine largeur) | bouton ✨ « Régénérer » sur toute la hauteur du message */
            <div data-message-row style={{ display: "flex", alignItems: "stretch", gap: 10, marginTop: 10 }}>
              <div style={{ flex: 1, minWidth: 0, padding: "10px 12px", background: T.bgCard, border: "1px solid #E4DEF5", borderRadius: 14, position: "relative" }}>
                <textarea
                  data-message-text
                  value={genMessage}
                  onChange={e => { setGenMessage(e.target.value); saveGenMessage(e.target.value); }}
                  rows={3}
                  ref={el => { if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }}   /* le champ s'ajuste à la longueur du message : rien n'est coupé */
                  style={{ width: "100%", boxSizing: "border-box", background: "transparent", border: "none", outline: "none", resize: "vertical", overflow: "hidden", display: "block", fontSize: 15, color: "#4B4868", lineHeight: 1.55, fontFamily: "inherit", paddingRight: 46 }}
                />
                <button onClick={copyGenMessage} title="Copier" aria-label="Copier" style={{ position: "absolute", top: 10, right: 10, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", background: genCopied ? "#DCFCE7" : T.bgCard, border: `1px solid ${genCopied ? "#16A34A40" : "#D9D3EE"}`, borderRadius: 10, cursor: "pointer", color: genCopied ? "#16A34A" : "#4B4868", transition: "all 0.2s" }}>
                  {genCopied ? (
                    <svg width="14" height="14" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5l2.5 2.5 4.5-5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="5" y="5" width="7" height="7" rx="1.3" stroke="currentColor" strokeWidth="1.3"/><path d="M3.5 9V2.8A1 1 0 014.5 1.8h6.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                  )}
                </button>
              </div>
              <button onClick={generateGenMessage} disabled={genLoading} title="Régénérer le message" aria-label="Régénérer le message" style={{ width: 52, flexShrink: 0, alignSelf: "stretch", display: "flex", alignItems: "center", justifyContent: "center", color: T.accent, background: "#E5DDFB", border: "none", borderRadius: 16, cursor: genLoading ? "wait" : "pointer", transition: "background 0.15s" }}
                onMouseEnter={e => { e.currentTarget.style.background = "#DBD0FA"; }} onMouseLeave={e => { e.currentTarget.style.background = "#E5DDFB"; }}>
                {genLoading ? (
                  <svg width="16" height="16" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg>
                ) : (
                  <span style={{ display: "flex", transform: "scale(1.6)" }}><IC.Sparkle /></span>
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Sync preview panel */}
      {syncState === "preview" && syncPreview.length > 0 && (
        <div style={{ margin: "12px 28px 0", background: "#F0EBFF", border: "1px solid #7550E340", borderRadius: 10, flexShrink: 0, display: "flex", flexDirection: "column", maxHeight: 300, overflow: "hidden" }}>
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
                      {a.waitingTag && <WaitingStamp size="sm" />}
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
      <div style={{ flex: 1, overflowY: "auto", padding: "13px 17px 15px", background: "#FBFAFF", scrollbarWidth: "thin", scrollbarColor: `${T.border} transparent` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: T.textPrimary, letterSpacing: -0.4 }}>Historique</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: T.accentText, background: T.accentBg, borderRadius: 999, padding: "2px 10px" }}>{sorted.length}</span>
          </div>
          <button onClick={() => setShowAddActivity(true)} style={{ display: "flex", alignItems: "center", gap: 7, height: 40, padding: "0 16px", background: T.accent, border: "none", borderRadius: 13, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 8px 18px rgba(117,80,227,0.28)" }}>
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
// Personnes à qui appartient le sujet (« Qui travaille dessus ? ») : avatars superposés + prénoms
function SubjectOwners({ project }) {
  const names = getAssignees(project);
  if (names.length === 0) {
    return <span data-card-owners style={{ marginLeft: "auto", flexShrink: 0, fontSize: 12, fontWeight: 500, color: T.textMuted }}>Non attribué</span>;
  }
  return (
    <span data-card-owners title={names.join(", ")} style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0, maxWidth: "55%" }}>
      <span style={{ display: "inline-flex", flexShrink: 0 }}>
        {names.map((name, i) => {
          const info = ASSIGNEE_INFO[name];
          return <span key={name} data-owner-avatar={name} style={{ width: 22, height: 22, boxSizing: "border-box", borderRadius: "50%", border: `2px solid ${T.bgCard}`, marginLeft: i === 0 ? 0 : -7, background: info?.color || T.accent, color: "#fff", fontSize: 8, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>{info?.abbr || name[0]}</span>;
        })}
      </span>
      <span style={{ fontSize: 12, fontWeight: 600, color: T.textSecondary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{names.join(", ")}</span>
    </span>
  );
}

function SubjectCard({ project, isSelected, onClick, showOwners = false }) {
  const platforms = Array.isArray(project.platforms) ? project.platforms : [];
  const last = sortEntries(project.timeline)[0];
  return (
    <button onClick={onClick} style={{ width: "100%", textAlign: "left", padding: 14, background: T.bgCard, border: `1.5px solid ${isSelected ? T.accent : "transparent"}`, borderRadius: T.radiusCard, boxShadow: isSelected ? "0 0 0 4px rgba(117,80,227,0.10), " + T.shadowCard : T.shadowCard, cursor: "pointer", transition: "border-color 0.15s, box-shadow 0.15s", outline: "none", marginBottom: 12, fontFamily: "inherit" }}
      onMouseEnter={e => { if (!isSelected) { e.currentTarget.style.borderColor = "rgba(117,80,227,0.35)"; e.currentTarget.style.boxShadow = T.shadowHover; } }}
      onMouseLeave={e => { if (!isSelected) { e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.boxShadow = T.shadowCard; } }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Ligne 1 : les tags (Jira, plateformes, puis priorité) — toujours présente, même sans aucun tag */}
          <div data-card-tags style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minHeight: 18, marginBottom: 8 }}>
            <JiraKey value={project.jiraKey} size="sm" />
            {platforms.map(p => <PlatformStamp key={p} name={p} size="sm" />)}
            {project.priority && <PriorityStamp priority={project.priority} size="sm" />}
            {/* Interlocuteur(s) : en haut à droite de la carte (dans la fenêtre « Ajouter un sujet », cette place sert aux propriétaires) */}
            {!showOwners && project.stakeholders?.length > 0 && <span data-card-person style={{ marginLeft: "auto", minWidth: 0, maxWidth: "50%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 500, lineHeight: 1.35, color: T.textMuted }}>{project.stakeholders.join(", ")}</span>}
            {/* À qui appartient le sujet : affiché seulement quand c'est demandé (fenêtre « Ajouter un sujet ») */}
            {showOwners && <SubjectOwners project={project} />}
          </div>
          {/* Ligne 2 : le titre, seul sur sa ligne */}
          <div data-card-title style={{ fontSize: 15, fontWeight: 700, letterSpacing: -0.2, lineHeight: 1.35, color: T.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: last ? 2 : 0 }}>{project.title}</div>
          {last && <div style={{ fontSize: 12.5, fontWeight: 500, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{last.text}</div>}
        </div>
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
  const [filterAssignee, setFilterAssignee] = useAssigneeFilter();
  const [showAddProject, setShowAddProject] = useState(false);

  const selected = projects.find(p => p.id === selectedId);

  // Navigate to target project from dashboard
  useEffect(() => {
    if (targetProjectId) {
      setSelectedId(targetProjectId);
      onTargetConsumed?.();
    }
  }, [targetProjectId]);

  const availablePlatforms = useMemo(() => {
    const all = projects.flatMap(p => p.platforms || []);
    return [...new Set(all)].sort();
  }, [projects]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return projects.filter(p => {
      const pPlats = p.platforms || [];
      const matchQ = !q || p.title.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q) || p.jiraKey?.toLowerCase().includes(q) || (p.stakeholders || []).some(s => s.toLowerCase().includes(q));
      return matchQ && (filterStatus === "all" || p.status === filterStatus) && (filterPlatform === "all" || pPlats.includes(filterPlatform)) && (filterAssignee === "all" || getAssignees(p).includes(filterAssignee));
    });
  }, [projects, search, filterStatus, filterPlatform, filterAssignee]);


  const sections = {
    in_progress: filtered.filter(p => p.status === "in_progress"),
    waiting:     filtered.filter(p => p.status === "waiting"),
    blocked:     filtered.filter(p => p.status === "blocked"),
    futur:       filtered.filter(p => p.status === "futur"),
    done:        filtered.filter(p => p.status === "done"),
  };
  // ── Sélection par défaut : la première carte de la liste affichée ──
  const topProject = Object.keys(STATUS_CONFIG).map(k => sections[k]).find(list => list.length > 0)?.[0] || null;

  // Rien de sélectionné (arrivée sur la page, données chargées plus tard) → première carte
  useEffect(() => {
    if (!selectedId && topProject && !targetProjectId) setSelectedId(topProject.id);
  }, [selectedId, topProject, targetProjectId]);

  // Sujet sélectionné supprimé → première carte
  useEffect(() => {
    if (selectedId && !projects.find(p => p.id === selectedId)) setSelectedId(topProject?.id || null);
  }, [projects, selectedId, topProject]);

  // Changement de filtre ou de recherche → la fiche passe sur la première carte de la nouvelle liste
  // (sauf à l'arrivée depuis un autre écran avec un sujet précis à ouvrir)
  const lastFilterKey = useRef(null);
  const arrivedWithTarget = useRef(!!targetProjectId);
  useEffect(() => {
    const key = [filterStatus, filterAssignee, filterPlatform, search].join("|");
    const isFirstRun = lastFilterKey.current === null;
    const changed = !isFirstRun && lastFilterKey.current !== key;
    lastFilterKey.current = key;
    if (changed || (isFirstRun && !arrivedWithTarget.current)) setSelectedId(topProject?.id || null);
  }, [filterStatus, filterAssignee, filterPlatform, search]);

  const assigneeFilteredProjects = useMemo(
    () => projects.filter(p => filterAssignee === "all" || getAssignees(p).includes(filterAssignee)),
    [projects, filterAssignee]
  );
  const counts = Object.fromEntries(Object.entries(STATUS_CONFIG).map(([k]) => [k, assigneeFilteredProjects.filter(p => p.status === k).length]));

  function renderSection(statusKey) {
    const items = sections[statusKey];
    const cfg = STATUS_CONFIG[statusKey];
    if (!items.length) return null;
    return (
      <div key={statusKey} style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.textPrimary, padding: "14px 4px 12px", display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: cfg.color, display: "inline-block" }} />
          {cfg.label}
          <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: T.textMuted }}>{items.length}</span>
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
      <div style={{ width: 452, flexShrink: 0, background: T.bg, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "17px 12px 7px", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 28, fontWeight: 800, color: T.textPrimary, letterSpacing: -0.8 }}>Sujets</div>
            </div>
            <button onClick={() => setShowAddProject(true)} title="Nouveau sujet" style={{ width: 46, height: 46, borderRadius: 15, display: "flex", alignItems: "center", justifyContent: "center", background: T.accent, border: "none", cursor: "pointer", color: "#fff", boxShadow: "0 10px 22px rgba(117,80,227,0.32)" }}>
              <IC.Plus />
            </button>
          </div>
          <div style={{ marginBottom: 10 }}>
            <PersonFilterDropdown value={filterAssignee} onChange={setFilterAssignee} />
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            {[{ key: "all", label: "Tous", count: assigneeFilteredProjects.length }, { key: "in_progress", label: "En cours", count: counts.in_progress, color: T.inProgress }, { key: "waiting", label: "En attente", count: counts.waiting, color: T.waiting }, { key: "blocked", label: "Bloqué", count: counts.blocked, color: "#DC2626" }, { key: "futur", label: "Futur", count: counts.futur, color: T.futur }, { key: "done", label: "Terminé", count: counts.done, color: T.done }].map(f => {
              const active = filterStatus === f.key;
              const col = f.color || T.textSecondary;
              return <button key={f.key} onClick={() => setFilterStatus(f.key)} style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 36, padding: "0 15px", borderRadius: 999, fontSize: 13, fontWeight: 600, fontFamily: "inherit", border: `1px solid ${active ? T.accent : T.border}`, background: active ? T.accent : "#FFFFFF", color: active ? "#fff" : T.textSecondary, boxShadow: active ? "0 8px 18px rgba(117,80,227,0.28)" : "0 1px 2px rgba(66,40,160,0.04)", cursor: "pointer", transition: "all 0.12s" }}>{f.label}<span style={{ fontWeight: 700, opacity: active ? 0.85 : 0.55 }}>{f.count}</span></button>;
            })}
          </div>
          <div style={{ position: "relative", marginBottom: 4 }}>
            <span style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", color: T.accent, display: "flex" }}><IC.Search /></span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Rechercher un sujet, un ticket…" style={{ width: "100%", boxSizing: "border-box", height: 46, padding: "0 42px 0 44px", background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: T.radiusInput, boxShadow: "0 1px 2px rgba(66,40,160,0.04)", color: T.textPrimary, fontSize: 13, fontWeight: 500, outline: "none", fontFamily: "inherit" }} />
            {search && <button onClick={() => setSearch("")} style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2, display: "flex" }}><IC.X /></button>}
          </div>
          </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "5px 12px 14px", scrollbarWidth: "thin", scrollbarColor: `${T.border} transparent` }}>
          {filtered.length === 0
            ? <div style={{ textAlign: "center", color: T.textMuted, fontSize: 13, padding: "48px 0" }}>Aucun résultat</div>
            : Object.keys(STATUS_CONFIG).map(k => renderSection(k))
          }
        </div>
      </div>

      {/* ── Detail ── */}
      <div style={{ flex: 1, overflow: "hidden", minWidth: 0, padding: "20px 20px 20px 0", boxSizing: "border-box" }}>
       <div style={{ height: "100%", background: T.bgCard, borderRadius: 26, boxShadow: T.shadowCard, overflow: "hidden" }}>
        {selected
          ? <SubjectDetail key={selected.id} project={selected} onUpdate={onUpdate} onDelete={(id) => { onDelete(id); }}
              onDeleteActivity={onDeleteActivity}
              incomingSync={incomingSync?.projectId === selected.id ? incomingSync : null}
              onSyncConsumed={onSyncConsumed} />
          : <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}><div style={{ fontSize: 40 }}>📋</div><div style={{ fontSize: 14, fontWeight: 700, color: T.textSecondary }}>Sélectionne un ticket</div><div style={{ fontSize: 12, color: T.textMuted }}>ou crée-en un nouveau</div></div>
        }
       </div>
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

function KanbanCard({ project, onUpdate, isDragging, isSelected, onOpen }) {
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
    <div onClick={onOpen} style={{
      background: T.bgCard, border: `1.5px solid ${isDragging ? "rgba(117,80,227,0.35)" : isSelected ? T.accent : "transparent"}`, borderRadius: 16,
      padding: "12px 14px 11px", marginBottom: 6, cursor: "pointer",
      boxShadow: isDragging ? "0 18px 40px rgba(66,40,160,0.22), 0 2px 6px rgba(66,40,160,0.08)" : (isSelected ? "0 0 0 4px rgba(117,80,227,0.10)" : "none"),
      cursor: isDragging ? "grabbing" : "pointer",
      transition: "box-shadow 0.15s, border-color 0.15s",
      userSelect: "none",
    }}
    onMouseEnter={e => { if (!isSelected) { e.currentTarget.style.borderColor = "rgba(117,80,227,0.35)"; } }}
    onMouseLeave={e => { if (!isSelected) { e.currentTarget.style.borderColor = "transparent"; } }}>
      {/* Numéro Jira + plateformes */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <JiraKey value={project.jiraKey} size="sm" />
        {platforms.map(p => <PlatformStamp key={p} name={p} size="sm" />)}
      </div>

      {/* Title */}
      <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: -0.2, color: T.textPrimary, lineHeight: 1.35, marginBottom: 6 }}>
        {project.title}
      </div>

      {/* Last activity */}
      {lastEntry && (
        <div style={{ fontSize: 12.5, fontWeight: 500, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 10 }}>
          {lastEntry.text}
        </div>
      )}

      {/* Footer */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {project.stakeholders?.length > 0 && (
          <span style={{ fontSize: 11.5, fontWeight: 500, color: T.textMuted }}>{project.stakeholders.join(", ")}</span>
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
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}`, display: "flex", alignItems: "flex-start" }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: T.accentText, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{project.nextAction}</span>
        </div>
      )}
    </div>
  );
}

function KanbanColumn({ column, projects, drag, zoneRef, onCardPointerDown, onOpen, selectedId }) {
  const cfg = STATUS_CONFIG[column.key];
  const count = projects.length;
  // Pendant un glisser, la carte déplacée quitte sa colonne et un emplacement s'ouvre à l'endroit visé
  const visible = drag ? projects.filter(p => p.id !== drag.id) : projects;
  const isOver = !!(drag && drag.target && drag.target.status === column.key);
  const phIndex = isOver ? Math.min(drag.target.index, visible.length) : -1;
  const placeholder = (
    <div key="__placeholder" data-kanban-placeholder style={{ height: drag ? Math.max(40, drag.height - 6) : 0, marginBottom: 6, borderRadius: 16, background: `${cfg.color}12`, border: `1.5px dashed ${cfg.color}66`, boxSizing: "border-box" }} />
  );
  const items = [];
  visible.forEach((p, i) => {
    if (i === phIndex) items.push(placeholder);
    items.push(
      <div
        key={p.id}
        data-kanban-card={p.id}
        style={{ position: "relative", display: "flow-root", touchAction: "manipulation" }}
        onPointerDown={e => onCardPointerDown(e, p)}
        onDragStart={e => e.preventDefault()}
      >
        <KanbanCard project={p} isSelected={p.id === selectedId} onOpen={() => onOpen(p.id)} />
      </div>
    );
  });
  if (phIndex === visible.length) items.push(placeholder);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", background: "rgba(117,80,227,0.05)", borderRadius: 22, padding: "14px 6px 4px", boxSizing: "border-box" }}>
      {/* Column header */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 10px 12px", flexShrink: 0 }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: cfg.color, flexShrink: 0 }} />
        <span style={{ fontSize: 15, fontWeight: 700, color: T.textPrimary }}>{column.label}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, background: "#FFFFFF", borderRadius: 999, padding: "2px 9px", boxShadow: "0 1px 2px rgba(66,40,160,0.06)" }}>{count}</span>
      </div>

      {/* Cards zone */}
      <div ref={zoneRef} data-kanban-zone={column.key} style={{
        position: "relative", flex: 1, overflowY: "auto", padding: "4px 0 10px", minHeight: 60,
        scrollbarWidth: "thin", scrollbarColor: `${T.border} transparent`,
      }}>
        {visible.length === 0 && !isOver && (
          <div style={{ textAlign: "center", color: T.textXMuted, fontSize: 12, padding: "24px 0" }}>Vide</div>
        )}
        {items}
      </div>
    </div>
  );
}

function KanbanPage({ projects: allProjects, onUpdate, onReorder, onDelete, onDeleteActivity, incomingSync, onSyncConsumed }) {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const selected = allProjects.find(p => p.id === selectedId) || null;

  // Échap ferme le panneau (sauf pendant la saisie dans un champ)
  useEffect(() => {
    if (!selectedId) return;
    const onKey = e => {
      if (e.key === "Escape" && !["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);
  const [filterAssignee, setFilterAssignee] = useAssigneeFilter();

  // Le sujet ouvert n'appartient plus au client affiché (changement de client) ou est supprimé :
  // on oublie la sélection, pour que le panneau ne se rouvre pas tout seul au retour.
  useEffect(() => {
    if (selectedId && !allProjects.some(p => p.id === selectedId)) setSelectedId(null);
  }, [allProjects, selectedId]);
  // Changement de personne : le panneau se referme, comme la fiche se met à jour sur la page Sujets.
  useEffect(() => { setSelectedId(null); }, [filterAssignee]);


  const projects = useMemo(
    () => allProjects.filter(p => filterAssignee === "all" || getAssignees(p).includes(filterAssignee)),
    [allProjects, filterAssignee]
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return projects;
    return projects.filter(p =>
      p.title.toLowerCase().includes(q) ||
      (p.stakeholders || []).some(s => s.toLowerCase().includes(q)) ||
      p.jiraKey?.toLowerCase().includes(q)
    );
  }, [projects, search]);

  // ── Glisser-déposer « en direct » ───────────────────────────────────────────
  // La carte suit la souris, un emplacement s'ouvre là où elle va tomber et les autres cartes glissent
  // pour lui faire de la place (animation FLIP). Au lâcher, la carte se pose dans son emplacement.
  const [drag, setDrag] = useState(null);        // { id, width, height, target: { status, index } }
  const dragMeta = useRef(null);                 // données du geste en cours (sans re-rendu)
  const overlayRef = useRef(null);
  const boardRef = useRef(null);
  const zoneRefs = useRef({});
  const flipSnap = useRef(null);
  const justDragged = useRef(0);
  const live = useRef({});                       // dernières versions des fonctions du geste
  const listeners = useRef(null);                // écouteurs stables, ajoutés / retirés à l'identique
  if (!listeners.current) listeners.current = {
    move: e => live.current.onPointerMove(e),
    up: e => live.current.onPointerUp(e),
    cancel: e => live.current.onPointerCancel(e),
    key: e => live.current.onDragKey(e),
    frame: () => live.current.autoScroll(),
  };
  const columnLists = useMemo(() => {
    const out = {};
    KANBAN_COLUMNS.forEach(col => { out[col.key] = byKanbanOrder(filtered.filter(p => p.status === col.key)); });
    return out;
  }, [filtered]);
  const listsRef = useRef(columnLists); listsRef.current = columnLists;
  const allRef = useRef(allProjects); allRef.current = allProjects;

  // Photo des positions affichées des cartes, juste avant un changement : sert à animer le déplacement
  function snapshotPositions() {
    const m = new Map();
    if (boardRef.current) boardRef.current.querySelectorAll("[data-kanban-card]").forEach(el => m.set(el.getAttribute("data-kanban-card"), el.getBoundingClientRect().top));
    flipSnap.current = m;
  }
  useLayoutEffect(() => {
    const snap = flipSnap.current;
    if (!snap || !boardRef.current) return;
    flipSnap.current = null;
    boardRef.current.querySelectorAll("[data-kanban-card]").forEach(el => {
      const prev = snap.get(el.getAttribute("data-kanban-card"));
      if (prev == null) return;
      el.style.transition = "none";
      el.style.transform = "";
      const delta = prev - el.getBoundingClientRect().top;
      if (Math.abs(delta) < 0.5) return;
      el.style.transform = `translateY(${delta}px)`;
      el.getBoundingClientRect();   // force le calcul avant de lancer l'animation
      el.style.transition = "transform 200ms cubic-bezier(0.2, 0.7, 0.2, 1)";
      el.style.transform = "";
    });
  });

  function placeOverlay() {
    const m = dragMeta.current, el = overlayRef.current;
    if (!m || !el || m.dropping) return;
    el.style.transform = `translate3d(${m.x - m.offX}px, ${m.y - m.offY}px, 0) rotate(1.5deg)`;
  }
  useLayoutEffect(() => { if (drag) placeOverlay(); }, [drag && drag.id]);

  // Emplacement visé : colonne la plus proche du pointeur, puis position parmi ses cartes (milieu de chaque carte)
  function computeTarget(x, y) {
    let best = null, bestDist = Infinity;
    KANBAN_COLUMNS.forEach(col => {
      const el = zoneRefs.current[col.key];
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (dx < bestDist) { bestDist = dx; best = { status: col.key, el, r }; }
    });
    if (!best) return null;
    const yIn = y - best.r.top + best.el.scrollTop;
    let index = 0;
    for (const c of best.el.querySelectorAll(":scope > [data-kanban-card]")) {
      if (yIn > c.offsetTop + c.offsetHeight / 2) index++; else break;
    }
    return { status: best.status, index };
  }
  function updateTarget() {
    const m = dragMeta.current;
    if (!m || !m.started || m.dropping) return;
    const t = computeTarget(m.x, m.y);
    if (!t || (m.target && t.status === m.target.status && t.index === m.target.index)) return;
    snapshotPositions();
    m.target = t;
    setDrag(d => d ? { ...d, target: t } : d);
  }

  function stopListening() {
    window.removeEventListener("pointermove", listeners.current.move);
    window.removeEventListener("pointerup", listeners.current.up);
    window.removeEventListener("pointercancel", listeners.current.cancel);
    window.removeEventListener("keydown", listeners.current.key);
    const m = dragMeta.current;
    if (m && m.raf) cancelAnimationFrame(m.raf);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }
  function finishDrag() {
    stopListening();
    if (dragMeta.current && dragMeta.current.started) justDragged.current = Date.now();
    dragMeta.current = null;
    setDrag(null);
  }
  // Défilement automatique d'une colonne quand on approche de son bord haut ou bas
  function autoScroll() {
    const m = dragMeta.current;
    if (!m || !m.started) return;
    if (!m.dropping && m.target) {
      const el = zoneRefs.current[m.target.status];
      if (el) {
        const r = el.getBoundingClientRect(), edge = 56;
        let v = 0;
        if (m.y < r.top + edge) v = -Math.ceil((r.top + edge - m.y) / 4);
        else if (m.y > r.bottom - edge) v = Math.ceil((m.y - (r.bottom - edge)) / 4);
        if (v) { const before = el.scrollTop; el.scrollTop += v; if (el.scrollTop !== before) updateTarget(); }
      }
    }
    m.raf = requestAnimationFrame(listeners.current.frame);
  }
  function onPointerMove(e) {
    const m = dragMeta.current;
    if (!m) return;
    m.x = e.clientX; m.y = e.clientY;
    if (!m.started) {
      if (Math.hypot(e.clientX - m.startX, e.clientY - m.startY) < 5) return;   // simple clic : pas de glisser
      m.started = true;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      snapshotPositions();
      m.target = { status: m.fromStatus, index: m.fromIndex };
      setDrag({ id: m.id, width: m.width, height: m.height, target: m.target });
      m.raf = requestAnimationFrame(listeners.current.frame);
    }
    placeOverlay();
    updateTarget();
  }
  function onPointerUp() {
    const m = dragMeta.current;
    if (!m || !m.started) { stopListening(); dragMeta.current = null; return; }
    if (m.dropping) return;
    m.dropping = true;
    const commit = () => {
      const t = m.target;
      const list = (listsRef.current[t.status] || []).filter(p => p.id !== m.id);
      const beforeId = list[t.index] ? list[t.index].id : null;
      // Le calcul se fait sur TOUS les sujets de la colonne (même ceux masqués par un filtre) pour garder un ordre cohérent
      const changes = planKanbanMove(allRef.current, m.id, t.status, beforeId);
      if (Object.keys(changes).length > 0) {
        if (onReorder) onReorder(changes);
        else Object.entries(changes).forEach(([pid, ch]) => onUpdate(pid, ch));
      }
      finishDrag();
    };
    // La carte se pose dans l'emplacement ouvert, puis prend sa place
    const ph = boardRef.current && boardRef.current.querySelector("[data-kanban-placeholder]");
    const el = overlayRef.current;
    if (ph && el) {
      const r = ph.getBoundingClientRect();
      el.style.transition = "transform 170ms cubic-bezier(0.2, 0.7, 0.2, 1)";
      el.style.transform = `translate3d(${r.left}px, ${r.top}px, 0) rotate(0deg)`;
      setTimeout(commit, 170);
    } else commit();
  }
  function onPointerCancel() { if (dragMeta.current && dragMeta.current.started) { snapshotPositions(); } finishDrag(); }
  function onDragKey(e) {
    if (e.key === "Escape" && dragMeta.current && dragMeta.current.started && !dragMeta.current.dropping) { snapshotPositions(); finishDrag(); }   // Échap annule le déplacement
  }
  function startPointer(e, project) {
    if (e.button !== 0 || dragMeta.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const list = listsRef.current[project.status] || [];
    dragMeta.current = {
      id: project.id, fromStatus: project.status, fromIndex: Math.max(0, list.findIndex(p => p.id === project.id)),
      startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY,
      offX: e.clientX - rect.left, offY: e.clientY - rect.top, width: rect.width, height: rect.height,
      started: false, target: null, dropping: false, raf: 0,
    };
    window.addEventListener("pointermove", listeners.current.move);
    window.addEventListener("pointerup", listeners.current.up);
    window.addEventListener("pointercancel", listeners.current.cancel);
    window.addEventListener("keydown", listeners.current.key);
  }
  live.current = { onPointerMove, onPointerUp, onPointerCancel, onDragKey, autoScroll, stopListening };
  useEffect(() => () => live.current.stopListening(), []);
  // Après un glisser, le relâchement ne doit pas ouvrir la fiche de la carte
  const openCard = (id) => { if (Date.now() - justDragged.current < 350) return; setSelectedId(id); };
  const dragProject = drag ? allProjects.find(p => p.id === drag.id) : null;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0, position: "relative" }}>
      {/* En-tête */}
      <div style={{ padding: "34px 40px 20px", flexShrink: 0, display: "flex", alignItems: "center", gap: 14 }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 800, color: T.textPrimary, letterSpacing: -0.8 }}>Kanban</div>
        </div>
        <div style={{ marginLeft: "auto", width: 230 }}>
          <PersonFilterDropdown value={filterAssignee} onChange={setFilterAssignee} />
        </div>
        <div style={{ position: "relative", width: 270 }}>
          <span style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", color: T.accent, display: "flex" }}><IC.Search /></span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Rechercher un sujet, un ticket…" style={{ width: "100%", boxSizing: "border-box", height: 46, padding: "0 16px 0 44px", background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: T.radiusInput, boxShadow: "0 1px 2px rgba(66,40,160,0.04)", fontSize: 13, fontWeight: 500, color: T.textPrimary, outline: "none", fontFamily: "inherit" }} />
        </div>
      </div>

      {/* Board */}
      <div style={{ flex: 1, overflow: "auto", padding: "4px 40px 28px" }}>
        <div ref={boardRef} style={{ display: "grid", gridTemplateColumns: `repeat(${KANBAN_COLUMNS.length}, minmax(0, 1fr))`, gap: 8, height: "calc(100% - 0px)", minHeight: 0 }}>
          {KANBAN_COLUMNS.map(col => (
            <KanbanColumn
              key={col.key}
              column={col}
              projects={columnLists[col.key]}
              drag={drag}
              zoneRef={el => { zoneRefs.current[col.key] = el; }}
              onCardPointerDown={startPointer}
              onOpen={openCard}
              selectedId={selectedId}
            />
          ))}
        </div>
      </div>

      {/* Carte en cours de déplacement : elle suit la souris */}
      {drag && dragProject && (
        <div ref={overlayRef} data-kanban-drag-overlay style={{ position: "fixed", left: 0, top: 0, width: drag.width, zIndex: 1000, pointerEvents: "none", willChange: "transform", transformOrigin: "50% 30%" }}>
          <KanbanCard project={dragProject} isDragging isSelected={false} onOpen={() => {}} />
        </div>
      )}

      {/* Panneau de détail : glisse depuis la droite et recouvre le tableau */}
      {selected && (
        <>
          <style>{`@keyframes kanbanPanelIn { from { transform: translateX(48px); opacity: 0; } to { transform: translateX(0); opacity: 1; } } @keyframes kanbanScrimIn { from { opacity: 0; } to { opacity: 1; } }`}</style>
          <div onClick={() => setSelectedId(null)} style={{ position: "absolute", inset: 0, background: "rgba(31,29,54,0.40)", zIndex: 20, animation: "kanbanScrimIn 0.18s ease-out" }} />
          <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: "min(780px, 92%)", background: T.bg, zIndex: 21, display: "flex", flexDirection: "column", borderLeft: `1px solid ${T.border}`, boxShadow: "-14px 0 44px rgba(0,0,0,0.18)", animation: "kanbanPanelIn 0.22s ease-out" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px", background: T.bgCard, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
              <span style={{ fontSize: 11, color: T.textMuted }}>Détail du sujet</span>
              <button onClick={() => setSelectedId(null)} title="Fermer (Échap)" style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 600, color: T.textSecondary }}>
                <IC.X /> Fermer
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
              <SubjectDetail
                key={selected.id}
                project={selected}
                onUpdate={onUpdate}
                onDelete={(id) => { onDelete(id); setSelectedId(null); }}
                onDeleteActivity={onDeleteActivity}
                incomingSync={incomingSync?.projectId === selected.id ? incomingSync : null}
                onSyncConsumed={onSyncConsumed}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── NEXT ACTION ITEM ─────────────────────────────────────────────────────────
// ─── NEXT ACTION ITEM ─────────────────────────────────────────────────────────
function NextActionItem({ project, onNavigate, onUpdateProject, isLast }) {
  const { user } = useUser();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [copied, setCopied] = useState(false);
  const [validated, setValidated] = useState(false);
  const [validating, setValidating] = useState(false);
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
      createdBy: user?.firstName || null,
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
    <div {...cardHover} style={{ background: T.bgCard, border: "1.5px solid transparent", borderRadius: T.radiusCard, padding: 14, boxShadow: T.shadowCard, transition: "border-color 0.15s, box-shadow 0.15s" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
        {/* Colonne de texte : tags, titre, prochaine action — empilés verticalement */}
        <div data-card-text style={{ flex: 1, minWidth: 0 }}>
          {/* Ligne 1 : les tags (Jira, plateformes, puis priorité) — toujours présente, même sans tag */}
          <div data-dash-tags style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minHeight: 19, marginBottom: 10 }}>
            <JiraKey value={project.jiraKey} size="md" />
            {platforms.slice(0, 2).map(pl => <PlatformStamp key={pl} name={pl} size="md" />)}
            {project.priority && <PriorityStamp priority={project.priority} size="md" />}
          </div>
          {/* Ligne 2 : le titre */}
          <div data-dash-title-row style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <span onClick={() => onNavigate("projects", project.id)} style={{ fontSize: 16, fontWeight: 700, letterSpacing: -0.2, color: T.textPrimary, cursor: "pointer" }}>{project.title}</span>
          </div>
          {/* Ligne 3 : la prochaine action */}
          <div style={{ fontSize: 14, fontWeight: 500, color: T.textSecondary, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{project.nextAction}</div>
        </div>
        {/* Colonne des boutons : collée en bas à droite */}
        <div data-card-actions style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              {message ? (
                <button onClick={validateAndLog} disabled={validating} title={validated ? "Ajouté à l'historique" : "Valider : marquer comme fait et ajouter à l'historique"} aria-label="Valider" data-validate-button style={{ width: 52, height: 40, flexShrink: 0, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", background: validated ? "#DCFCE7" : "#E9F7EF", border: "1px solid #2DA66A40", borderRadius: 14, cursor: validating ? "wait" : "pointer", color: "#1F8A55", transition: "background 0.15s, border-color 0.15s", opacity: validating ? 0.6 : 1 }}
                  onMouseEnter={e => { if (!validated) { e.currentTarget.style.background = "#2DA66A"; e.currentTarget.style.borderColor = "#2DA66A"; e.currentTarget.style.color = "#fff"; } }}
                  onMouseLeave={e => { if (!validated) { e.currentTarget.style.background = "#E9F7EF"; e.currentTarget.style.borderColor = "#2DA66A40"; e.currentTarget.style.color = "#1F8A55"; } }}>
                  {validating ? <svg width="16" height="16" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg> : <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4.5 10.5l3.5 3.5 7.5-8.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                </button>
              ) : (
                <button onClick={generateMessage} disabled={loading} title={loading ? "Rédaction…" : "Rédiger"} aria-label={loading ? "Rédaction…" : "Rédiger"} style={{ width: 52, height: 52, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: T.accent, background: "#E5DDFB", border: "none", borderRadius: 16, transition: "background 0.15s", cursor: loading ? "wait" : "pointer" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "#DBD0FA"; }} onMouseLeave={e => { e.currentTarget.style.background = "#E5DDFB"; }}>
                  {loading ? <svg width="16" height="16" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg> : <span style={{ display: "flex", transform: "scale(1.6)" }}><IC.Sparkle /></span>}
                </button>
              )}
        </div>
      </div>

      {loading && !message && (
        <div style={{ marginTop: 12, padding: "10px 12px", background: "#F8F6FE", border: "1px solid #E4DEF5", borderRadius: 14, display: "flex", alignItems: "center", gap: 8 }}>
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
        /* Le message (pleine largeur) | bouton ✨ « Régénérer » sur toute la hauteur du message — même design que la fiche d'un sujet */
        <div data-message-row style={{ display: "flex", alignItems: "stretch", gap: 10, marginTop: 12 }}>
          <div style={{ flex: 1, minWidth: 0, padding: "10px 12px", background: "#F8F6FE", border: "1px solid #E4DEF5", borderRadius: 14, position: "relative" }}>
            <textarea
              data-message-text
              value={message}
              onChange={e => { setMessage(e.target.value); saveMessage(e.target.value); }}
              rows={3}
              ref={el => { if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }}
              style={{ width: "100%", boxSizing: "border-box", background: "transparent", border: "none", outline: "none", resize: "vertical", overflow: "hidden", display: "block", fontSize: 15, color: "#4B4868", lineHeight: 1.55, fontFamily: "inherit", paddingRight: 46 }}
            />
            <button onClick={copy} title="Copier" aria-label="Copier" style={{ position: "absolute", top: 10, right: 10, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", background: copied ? "#DCFCE7" : T.bgCard, border: `1px solid ${copied ? "#16A34A40" : "#D9D3EE"}`, borderRadius: 10, cursor: "pointer", color: copied ? "#16A34A" : "#4B4868", transition: "all 0.2s" }}>
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5l2.5 2.5 4.5-5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="5" y="5" width="7" height="7" rx="1.3" stroke="currentColor" strokeWidth="1.3"/><path d="M3.5 9V2.8A1 1 0 014.5 1.8h6.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
              )}
            </button>
          </div>
          <button onClick={generateMessage} disabled={loading} title="Régénérer" aria-label="Régénérer" style={{ width: 52, flexShrink: 0, alignSelf: "stretch", display: "flex", alignItems: "center", justifyContent: "center", color: T.accent, background: "#E5DDFB", border: "none", borderRadius: 16, cursor: loading ? "wait" : "pointer", transition: "background 0.15s" }}
            onMouseEnter={e => { e.currentTarget.style.background = "#DBD0FA"; }} onMouseLeave={e => { e.currentTarget.style.background = "#E5DDFB"; }}>
            {loading ? <svg width="16" height="16" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg> : <span style={{ display: "flex", transform: "scale(1.6)" }}><IC.Sparkle /></span>}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── RELANCE ITEM ─────────────────────────────────────────────────────────────
function RelanceItem({ project, days, waitingBadgeColor, onNavigate, onUpdateProject, isLast }) {
  const { user } = useUser();
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
      createdBy: user?.firstName || null,
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
    <div {...cardHover} style={{ background: T.bgCard, border: "1.5px solid transparent", borderRadius: T.radiusCard, padding: 14, boxShadow: T.shadowCard, transition: "border-color 0.15s, box-shadow 0.15s" }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
        <div data-card-text style={{ flex: 1, minWidth: 0 }}>
          {/* Ligne 1 : les tags (Jira, plateformes, puis priorité) — toujours présente, même sans tag */}
          <div data-dash-tags style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minHeight: 18, marginBottom: 8 }}>
            <JiraKey value={project.jiraKey} size="sm" />
            {platforms.slice(0, 2).map(pl => <PlatformStamp key={pl} name={pl} size="sm" />)}
            {project.priority && <PriorityStamp priority={project.priority} size="sm" />}
          </div>
          {/* Ligne 2 : le titre */}
          <div data-dash-title-row style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <span onClick={() => onNavigate("projects", project.id)} style={{ fontSize: 15, fontWeight: 700, letterSpacing: -0.2, color: T.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}>{project.title}</span>
          </div>
          {/* Ligne 3 : les interlocuteurs */}
          {project.stakeholders?.length > 0 && (
            <span style={{ display: "block", fontSize: 11, lineHeight: 1.35, color: T.textMuted }}>{project.stakeholders.join(", ")}</span>
          )}
        </div>
        {/* Colonne de droite : délai + bouton, collés en bas à droite */}
        <div data-card-actions style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: wc.color, background: wc.bg, padding: "2px 8px", borderRadius: 10, whiteSpace: "nowrap" }}>
          {days === 0 ? "Auj." : days === 1 ? "Hier" : days < 7 ? `${days}j` : days < 30 ? `${Math.floor(days / 7)} sem.` : `${Math.floor(days / 30)} mois`}
        </span>
        {relance ? (
          <button onClick={validateAndLog} disabled={validating} title={validated ? "Ajouté à l'historique" : "Valider : marquer comme envoyé et ajouter à l'historique"} aria-label="Valider" data-validate-button style={{ width: 52, height: 40, flexShrink: 0, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", background: validated ? "#DCFCE7" : "#E9F7EF", border: "1px solid #2DA66A40", borderRadius: 14, cursor: validating ? "wait" : "pointer", color: "#1F8A55", transition: "background 0.15s, border-color 0.15s", opacity: validating ? 0.6 : 1 }}
                  onMouseEnter={e => { if (!validated) { e.currentTarget.style.background = "#2DA66A"; e.currentTarget.style.borderColor = "#2DA66A"; e.currentTarget.style.color = "#fff"; } }}
                  onMouseLeave={e => { if (!validated) { e.currentTarget.style.background = "#E9F7EF"; e.currentTarget.style.borderColor = "#2DA66A40"; e.currentTarget.style.color = "#1F8A55"; } }}>
                  {validating ? <svg width="16" height="16" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg> : <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4.5 10.5l3.5 3.5 7.5-8.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                </button>
        ) : (
          <button onClick={generateRelance} disabled={loading} title={loading ? "Rédaction…" : "Relancer"} aria-label={loading ? "Rédaction…" : "Relancer"} style={{ width: 52, height: 52, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: T.accent, background: "#E5DDFB", border: "none", borderRadius: 16, transition: "background 0.15s", cursor: loading ? "wait" : "pointer" }}
            onMouseEnter={e => { e.currentTarget.style.background = "#DBD0FA"; }} onMouseLeave={e => { e.currentTarget.style.background = "#E5DDFB"; }}>
            {loading ? <svg width="16" height="16" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg> : <span style={{ display: "flex", transform: "scale(1.6)" }}><IC.Sparkle /></span>}
          </button>
        )}
        </div>
      </div>

      {loading && !relance && (
        <div style={{ marginTop: 12, padding: "10px 12px", background: "#F8F6FE", border: "1px solid #E4DEF5", borderRadius: 14, display: "flex", alignItems: "center", gap: 8 }}>
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
        /* Le message (pleine largeur) | bouton ✨ « Régénérer » sur toute la hauteur du message — même design que la fiche d'un sujet */
        <div data-message-row style={{ display: "flex", alignItems: "stretch", gap: 10, marginTop: 12 }}>
          <div style={{ flex: 1, minWidth: 0, padding: "10px 12px", background: "#F8F6FE", border: "1px solid #E4DEF5", borderRadius: 14, position: "relative" }}>
            <textarea
              data-message-text
              value={relance}
              onChange={e => { setRelance(e.target.value); saveRelance(e.target.value); }}
              rows={3}
              ref={el => { if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }}
              style={{ width: "100%", boxSizing: "border-box", background: "transparent", border: "none", outline: "none", resize: "vertical", overflow: "hidden", display: "block", fontSize: 15, color: "#4B4868", lineHeight: 1.55, fontFamily: "inherit", paddingRight: 46 }}
            />
            <button onClick={copy} title="Copier" aria-label="Copier" style={{ position: "absolute", top: 10, right: 10, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", background: copied ? "#DCFCE7" : T.bgCard, border: `1px solid ${copied ? "#16A34A40" : "#D9D3EE"}`, borderRadius: 10, cursor: "pointer", color: copied ? "#16A34A" : "#4B4868", transition: "all 0.2s" }}>
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5l2.5 2.5 4.5-5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="5" y="5" width="7" height="7" rx="1.3" stroke="currentColor" strokeWidth="1.3"/><path d="M3.5 9V2.8A1 1 0 014.5 1.8h6.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
              )}
            </button>
          </div>
          <button onClick={generateRelance} disabled={loading} title="Régénérer" aria-label="Régénérer" style={{ width: 52, flexShrink: 0, alignSelf: "stretch", display: "flex", alignItems: "center", justifyContent: "center", color: T.accent, background: "#E5DDFB", border: "none", borderRadius: 16, cursor: loading ? "wait" : "pointer", transition: "background 0.15s" }}
            onMouseEnter={e => { e.currentTarget.style.background = "#DBD0FA"; }} onMouseLeave={e => { e.currentTarget.style.background = "#E5DDFB"; }}>
            {loading ? <svg width="16" height="16" viewBox="0 0 10 10" fill="none" style={{ animation: "spin 1s linear infinite" }}><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="14" strokeDashoffset="7"/></svg> : <span style={{ display: "flex", transform: "scale(1.6)" }}><IC.Sparkle /></span>}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── DASHBOARD PAGE ───────────────────────────────────────────────────────────
// ─── ACTIVITY PAGE ────────────────────────────────────────────────────────────
// ─── AJOUT RAPIDE PAR SEMAINE : choisir un sujet, reprend son dernier commentaire ──
function AddToWeekPicker({ projects, weekLabel = "", onAdd, onClose }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const sortedProjects = [...projects].sort((a, b) => a.title.localeCompare(b.title));
  // Recherche : sans tenir compte des accents ni des majuscules ; tous les mots saisis doivent être trouvés
  const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const terms = norm(query).split(/\s+/).filter(Boolean);
  const results = sortedProjects.filter(p => {
    if (terms.length === 0) return true;
    const last = sortEntries(p.timeline || [])[0];
    const hay = norm([p.title, p.jiraKey, ...(p.jiraLinks || []).map(l => l.key), (p.platforms || []).join(" "), (p.stakeholders || []).join(" "), getAssignees(p).join(" "), last && last.text].join(" "));
    return terms.every(t => hay.includes(t));
  });

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(31,29,54,0.40)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ background: T.bgCard, borderRadius: 26, width: 640, maxWidth: "92vw", maxHeight: "82vh", display: "flex", flexDirection: "column", boxShadow: T.shadowPop, overflow: "hidden" }} onClick={e => e.stopPropagation()}>
        {/* En-tête : titre, nombre de sujets, recherche */}
        <div data-picker-header style={{ padding: "22px 24px 16px", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.5, color: T.textPrimary }}>Choisir un sujet</div>
              <div data-picker-count style={{ fontSize: 13, fontWeight: 500, color: T.textMuted, marginTop: 3 }}>
                {terms.length > 0 ? `${results.length} résultat${results.length > 1 ? "s" : ""} sur ${sortedProjects.length}` : `${sortedProjects.length} sujet${sortedProjects.length > 1 ? "s" : ""}`} · {weekLabel}
              </div>
            </div>
            <button onClick={onClose} title="Fermer" aria-label="Fermer" style={{ width: 34, height: 34, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: T.bgHover, border: "none", borderRadius: 12, color: T.textMuted, cursor: "pointer" }}><IC.X /></button>
          </div>
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", color: T.accent, display: "flex" }}><IC.Search /></span>
            <input
              ref={inputRef}
              data-picker-search
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === "Escape") onClose(); }}
              placeholder="Rechercher un sujet, un ticket, une personne…"
              style={{ width: "100%", boxSizing: "border-box", height: 46, padding: "0 42px 0 44px", background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: T.radiusInput, boxShadow: "0 1px 2px rgba(66,40,160,0.04)", color: T.textPrimary, fontSize: 13, fontWeight: 500, outline: "none", fontFamily: "inherit" }}
            />
            {query && <button onClick={() => { setQuery(""); inputRef.current?.focus(); }} title="Effacer" aria-label="Effacer la recherche" style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2, display: "flex" }}><IC.X /></button>}
          </div>
        </div>
        {/* Liste : mêmes cartes que la page Sujets, sur fond teinté pour les mettre en avant */}
        <div data-picker-list style={{ flex: 1, overflowY: "auto", padding: "14px 24px 8px", background: T.bg, borderTop: `1px solid ${T.border}`, minHeight: 120 }}>
          {sortedProjects.length === 0 ? (
            <div style={{ padding: "36px 0", fontSize: 13, fontWeight: 500, color: T.textMuted, textAlign: "center" }}>Tous les sujets sont déjà présents cette semaine</div>
          ) : results.length === 0 ? (
            <div data-picker-empty style={{ padding: "36px 0", fontSize: 13, fontWeight: 500, color: T.textMuted, textAlign: "center" }}>Aucun sujet ne correspond à « {query.trim()} »</div>
          ) : results.map(p => {
            const last = sortEntries(p.timeline || [])[0];
            return <SubjectCard key={p.id} project={p} isSelected={false} onClick={() => onAdd(p, last)} showOwners />;
          })}
        </div>
      </div>
    </div>
  );
}

function ActivityPage({ projects, onNavigate, onUpdateProject }) {
  const { user } = useUser();
  const [expandedWeeks, setExpandedWeeks] = useState(null); // null = pas encore initialisé
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState(null); // { entry } à confirmer
  const [snackbar, setSnackbar] = useState(null);
  const [addPickerWeek, setAddPickerWeek] = useState(null);
  const [copiedEntryId, setCopiedEntryId] = useState(null);   // carte dont le bouton « copier » vient d'être utilisé

  // Copie « titre + lien Jira » séparés par une tabulation : se colle en 2 cellules dans Excel
  function copyEntry(e) {
    const jiraUrl = e.project.jiraUrl || e.project.jiraLinks?.[0]?.url || "";
    const combined = jiraUrl ? `${e.project.title}\t${jiraUrl}` : e.project.title;
    copyToClipboard(combined).then(ok => {
      if (ok) {
        setSnackbar(jiraUrl ? "Titre + lien Jira copiés" : `"${e.project.title}" copié`);
        setTimeout(() => setSnackbar(null), 2000);
        setCopiedEntryId(e.id);
        setTimeout(() => setCopiedEntryId(cur => (cur === e.id ? null : cur)), 1500);
      }
    });
  } // weekStart pour lequel le sélecteur est ouvert

  function getWeekStart(dateStr) {
    const d = new Date(dateStr);
    const dow = d.getDay() === 0 ? 6 : d.getDay() - 1; // lundi = 0
    const monday = new Date(d);
    monday.setDate(d.getDate() - dow);
    monday.setHours(0, 0, 0, 0);
    return monday.toISOString().slice(0, 10);
  }
  const currentWeekStart = getWeekStart(today());
  // Une date située DANS la semaine demandée, quel que soit le fuseau horaire :
  // la clé d'une semaine peut être le dimanche qui précède le lundi, donc on cherche le premier jour qui retombe bien dans cette semaine.
  function dateInWeek(weekStart) {
    const base = new Date(weekStart + "T12:00:00");
    for (let k = 0; k < 7; k++) {
      const d = new Date(base); d.setDate(base.getDate() + k);
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (getWeekStart(ymd) === weekStart) return ymd;
    }
    return weekStart;
  }

  const allEntries = useMemo(() => {
    return projects
      .flatMap(p => (p.timeline || []).map(e => ({ ...e, project: p })))
      .filter(e => e.createdBy === user?.firstName)
      .sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        const tA = a.createdAt || a.id || "";
        const tB = b.createdAt || b.id || "";
        return tB.localeCompare(tA);
      });
  }, [projects, user]);

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
    // La semaine en cours est toujours affichée, même sans aucune activité
    if (!groups.some(g => g.weekStart === currentWeekStart)) {
      groups.push({ weekStart: currentWeekStart, entries: [], seenProjects: new Set() });
      groups.sort((a, b) => b.weekStart.localeCompare(a.weekStart));
    }
    return groups;
  }, [filtered, currentWeekStart]);

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

    // Numéro de semaine calculé par rapport à une date calendaire fixe :
    // le lundi 21 septembre 2026 correspond à la semaine ISO 39.
    const ANCHOR_MONDAY = new Date("2026-09-21T00:00:00");
    const ANCHOR_WEEK_NUMBER = 39;
    const weeksDiff = Math.round((monday - ANCHOR_MONDAY) / (7 * 24 * 60 * 60 * 1000));
    const weekNumber = ANCHOR_WEEK_NUMBER + weeksDiff;

    if (weekStart === thisMonday.toISOString().slice(0, 10)) return `Cette semaine · S${weekNumber}`;
    if (weekStart === lastMonday.toISOString().slice(0, 10)) return `Semaine dernière · S${weekNumber}`;
    const sameMonth = monday.getMonth() === sunday.getMonth();
    const startStr = monday.toLocaleDateString("fr-FR", { day: "numeric", month: sameMonth ? undefined : "short" });
    const endStr = sunday.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
    return `${startStr} — ${endStr}  ·  S${weekNumber}`;
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
      <div style={{ padding: "34px 40px 10px", flexShrink: 0 }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: T.textPrimary, letterSpacing: -0.8 }}>Activité</div>
        </div>
      </div>


      <div style={{ flex: 1, overflowY: "auto", padding: "14px 40px 44px", scrollbarWidth: "thin", scrollbarColor: `${T.border} transparent` }}>
        {grouped.length === 0 ? (
          <div style={{ textAlign: "center", color: T.textMuted, fontSize: 13, padding: "60px 0" }}>Aucune activité trouvée</div>
        ) : (
          <div style={{ maxWidth: 900, margin: "0 auto" }}>
            {grouped.map((group, gi) => {
              const isExpanded = expandedWeeks?.has(group.weekStart);
              const totalDays = Math.min(5, group.entries.reduce((sum, e) => sum + (e.project.weeklyTime?.[group.weekStart] || 0), 0));
              const pickerOpen = addPickerWeek === group.weekStart;
              return (
              <div key={group.weekStart} style={{ marginBottom: 34 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                  <button onClick={() => toggleWeek(group.weekStart)} style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0, background: "none", border: "none", padding: 0, cursor: "pointer" }}>
                    <span style={{ display: "flex", alignItems: "center", color: T.textMuted, transform: isExpanded ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }}><IC.Chevron /></span>
                    <span style={{ fontSize: 17, fontWeight: 800, color: T.textPrimary, letterSpacing: -0.3 }}>
                      {formatWeekLabel(group.weekStart)}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: T.accentText, background: T.accentBg, borderRadius: 999, padding: "2px 10px" }}>{group.entries.length}</span>
                  </button>
                  <span style={{ fontSize: 13, color: T.textSecondary, fontWeight: 700, flexShrink: 0 }}>{totalDays} j</span>
                </div>
                {isExpanded && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {group.entries.map(e => {
                    const cfg = ACTIVITY_TYPES[e.type] || ACTIVITY_TYPES.note;
                    const platforms = e.project.platforms || [];
                    const timeSpent = e.project.weeklyTime?.[group.weekStart] || 0;
                    const atCap = totalDays >= 5;

                    function adjustTime(delta) {
                      if (delta > 0 && totalDays >= 5) return; // Plafond de 5 jours par semaine
                      const next = Math.max(0, Math.round((timeSpent + delta) * 100) / 100);
                      onUpdateProject(e.project.id, {
                        weeklyTime: { ...(e.project.weeklyTime || {}), [group.weekStart]: next },
                      });
                    }

                    return (
                      <div key={e.id} onClick={() => onNavigate("projects", e.project.id)} {...cardHover} style={{ position: "relative", background: T.bgCard, border: "1.5px solid transparent", borderRadius: T.radiusCard, boxShadow: T.shadowCard, padding: "20px 170px 20px 24px", cursor: "pointer", transition: "border-color 0.15s, box-shadow 0.15s" }}>
                        {/* Ligne 1 : les tags (badge Jira, plateformes) — toujours présente, même sans tag */}
                        <div data-activity-tags style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minHeight: 19, marginBottom: 10 }}>
                          <JiraKey
                            value={e.project.jiraKey}
                            size="md"
                            title="Cliquer pour copier le lien Jira"
                            onClick={ev => {
                              ev.stopPropagation();
                              const url = e.project.jiraUrl || e.project.jiraLinks?.[0]?.url || e.project.jiraKey;
                              copyToClipboard(url).then(ok => {
                                if (ok) {
                                  setSnackbar(`"${url}" copié`);
                                  setTimeout(() => setSnackbar(null), 2000);
                                }
                              });
                            }}
                          />
                          {platforms.slice(0, 2).map(pl => <PlatformStamp key={pl} name={pl} size="md" />)}
                        </div>
                        {/* Ligne 2 : le titre + le bouton copier */}
                        <div data-activity-title-row style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                          <span
                            onClick={ev => { ev.stopPropagation(); copyEntry(e); }}
                            title="Cliquer pour copier le titre et le lien Jira (colle en 2 colonnes dans Excel)"
                            style={{ fontSize: 16, fontWeight: 700, letterSpacing: -0.2, color: T.textPrimary, cursor: "pointer" }}
                          >
                            {e.project.title}
                          </span>
                          <button
                            data-copy-entry={e.id}
                            onClick={ev => { ev.stopPropagation(); copyEntry(e); }}
                            title="Copier le titre et le lien Jira (se colle en 2 colonnes dans Excel)"
                            aria-label="Copier le titre et le lien Jira"
                            style={{ width: 20, height: 20, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, background: copiedEntryId === e.id ? "#DCFCE7" : T.bgCard, border: `1px solid ${copiedEntryId === e.id ? "#16A34A40" : T.border}`, borderRadius: 5, cursor: "pointer", color: copiedEntryId === e.id ? "#16A34A" : T.textMuted, transition: "all 0.2s" }}
                            onMouseEnter={ev => { if (copiedEntryId !== e.id) { ev.currentTarget.style.background = T.bgHover; ev.currentTarget.style.color = T.textPrimary; } }}
                            onMouseLeave={ev => { if (copiedEntryId !== e.id) { ev.currentTarget.style.background = T.bgCard; ev.currentTarget.style.color = T.textMuted; } }}>
                            {copiedEntryId === e.id ? (
                              <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5l2.5 2.5 4.5-5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            ) : (
                              <svg width="11" height="11" viewBox="0 0 14 14" fill="none"><rect x="5" y="5" width="7" height="7" rx="1.3" stroke="currentColor" strokeWidth="1.3"/><path d="M3.5 9V2.8A1 1 0 014.5 1.8h6.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                            )}
                          </button>
                        </div>
                        {/* Ligne 3 : la dernière activité */}
                        <div data-activity-text style={{ fontSize: 14, fontWeight: 500, color: T.textSecondary, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: cfg.color, marginRight: 8 }}>{cfg.label}</span>
                          {e.text}
                        </div>
                        <div style={{ position: "absolute", top: "50%", right: 20, transform: "translateY(-50%)", display: "flex", alignItems: "center", gap: 8 }} onClick={ev => ev.stopPropagation()}>
                          <div style={{ display: "flex", alignItems: "center", gap: 4, background: T.bgHover, borderRadius: 999, padding: "3px 4px" }}>
                            <button onClick={() => adjustTime(-0.25)} aria-label="Retirer un quart de jour" style={{ width: 18, height: 18, borderRadius: "50%", border: "none", background: "transparent", color: T.textSecondary, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, transition: "background 0.12s, color 0.12s" }}
                              onMouseEnter={ev => { ev.currentTarget.style.background = T.bgCard; ev.currentTarget.style.color = T.textPrimary; }}
                              onMouseLeave={ev => { ev.currentTarget.style.background = "transparent"; ev.currentTarget.style.color = T.textSecondary; }}>
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 5h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
                            </button>
                            <span
                              onClick={ev => {
                                ev.stopPropagation();
                                copyToClipboard(String(timeSpent)).then(ok => {
                                  if (ok) {
                                    setSnackbar(`"${timeSpent}" copié`);
                                    setTimeout(() => setSnackbar(null), 2000);
                                  }
                                });
                              }}
                              title="Cliquer pour copier le nombre de jours"
                              style={{ fontSize: 12, fontWeight: 700, color: T.textPrimary, minWidth: 18, textAlign: "center", cursor: "pointer" }}
                            >
                              {timeSpent}
                            </span>
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

                  {group.entries.length === 0 && (
                    <div style={{ fontSize: 12, color: T.textMuted, textAlign: "center", padding: "6px 0 2px" }}>Aucune activité cette semaine</div>
                  )}

                  <button onClick={() => setAddPickerWeek(group.weekStart)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "10px 12px", background: "transparent", border: `1.5px dashed ${T.border}`, borderRadius: 12, cursor: "pointer", color: T.textMuted, fontSize: 12, fontWeight: 600 }}
                    onMouseEnter={ev => { ev.currentTarget.style.borderColor = T.accent; ev.currentTarget.style.color = T.accent; }}
                    onMouseLeave={ev => { ev.currentTarget.style.borderColor = T.border; ev.currentTarget.style.color = T.textMuted; }}>
                    <IC.Plus /> Ajouter un sujet
                  </button>

                  {pickerOpen && (
                    <AddToWeekPicker
                      projects={projects.filter(p => !group.entries.some(e => e.project.id === p.id))}
                      weekLabel={group.weekStart === currentWeekStart ? "semaine en cours" : formatWeekLabel(group.weekStart)}
                      onClose={() => setAddPickerWeek(null)}
                      onAdd={(project) => {
                        const entryDate = group.weekStart === currentWeekStart ? today() : dateInWeek(group.weekStart);
                        const history = project.timeline || [];
                        // On recopie la dernière activité du sujet telle quelle (type et texte), même s'il s'agit d'une relance ou d'un retour.
                        // Seul un sujet sans aucun historique reçoit une « Mise à jour » vide.
                        const source = sortEntries(history)[0];
                        const newEntry = {
                          id: `e${Date.now()}`,
                          type: source?.type || "update",
                          date: entryDate,
                          text: source?.text || "",
                          createdAt: new Date().toISOString(),
                          createdBy: user?.firstName || null,
                        };
                        const nextTimeline = [...history, newEntry];
                        onUpdateProject(project.id, { timeline: nextTimeline, lastActivity: latestDate(nextTimeline) });
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
            const nextTimeline = confirmDeleteEntry.project.timeline.filter(te => te.id !== confirmDeleteEntry.id);
            onUpdateProject(confirmDeleteEntry.project.id, {
              timeline: nextTimeline,
              lastActivity: latestDate(nextTimeline),
            });
            setConfirmDeleteEntry(null);
          }}
        />
      )}

      {snackbar && (
        <div style={{ position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)", zIndex: 1000, background: "#1C1C1E", color: "#fff", fontSize: 13, fontWeight: 500, padding: "10px 20px", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.25)", pointerEvents: "none", whiteSpace: "nowrap" }}>
          {snackbar}
        </div>
      )}
    </div>
  );
}

// ─── DASHBOARD PAGE ───────────────────────────────────────────────────────────
function DashboardPage({ projects: allProjects, onNavigate, onUpdateProject }) {
  const [waitingCollapsed, setWaitingCollapsed] = useState(false);
  const [filterAssignee, setFilterAssignee] = useAssigneeFilter();
  const projects = useMemo(
    () => allProjects.filter(p => filterAssignee === "all" || getAssignees(p).includes(filterAssignee)),
    [allProjects, filterAssignee]
  );
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
    <div style={{ background: T.bgCard, border: "1.5px solid transparent", borderRadius: T.radiusCard, padding: "18px 20px", boxShadow: T.shadowCard, ...style }}>
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
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0, background: T.bg }}>
      {/* En-tête : même largeur max (900 px, centrée) et mêmes marges que la page Activité */}
      <div style={{ padding: "34px 40px 10px", flexShrink: 0 }}>
        <div data-dash-column style={{ maxWidth: 900, margin: "0 auto", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.textPrimary, letterSpacing: -0.8 }}>
              Bonjour 👋
            </div>
            <div style={{ fontSize: 14, fontWeight: 500, color: T.textMuted, marginTop: 6 }}>
              {dayName.charAt(0).toUpperCase() + dayName.slice(1)} {dateLabel}
            </div>
          </div>
          <div style={{ width: 230, flexShrink: 0 }}>
            <PersonFilterDropdown value={filterAssignee} onChange={setFilterAssignee} />
          </div>
        </div>
      </div>

      {/* Contenu défilant : même colonne de 900 px centrée */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "14px 40px 44px", scrollbarWidth: "thin", scrollbarColor: `${T.border} transparent` }}>
      <div data-dash-column style={{ maxWidth: 900, margin: "0 auto" }}>

        {/* ── Row 1 : Stat cards ── */}
        <div data-dash-stats style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(128px, 1fr))", gap: 16, marginBottom: 34 }}>
          {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
            <Card key={key} style={{ padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <span style={{ width: 40, height: 40, borderRadius: 13, background: `${cfg.color}1A`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ width: 12, height: 12, borderRadius: "50%", background: cfg.color, display: "inline-block" }} />
                </span>
                <span style={{ fontSize: 30, fontWeight: 800, color: T.textPrimary, letterSpacing: -1 }}>{counts[key] || 0}</span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.3, color: T.textPrimary }}>{cfg.label}</div>
            </Card>
          ))}
        </div>

        {/* ── Row 2 : Next actions + Waiting + Recent activity ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>

          {/* Prochaines actions */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <span style={{ fontSize: 18, fontWeight: 800, color: T.textPrimary, letterSpacing: -0.4 }}>Prochaines actions</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: T.accentText, background: T.accentBg, borderRadius: 999, padding: "2px 10px" }}>{nextActions.length}</span>
            </div>
            {nextActions.length === 0 ? (
              <div style={{ fontSize: 13, color: T.textMuted, textAlign: "center", padding: "20px 0" }}>Aucune action en attente 🎉</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {nextActions.map((p) => (
                  <NextActionItem key={p.id} project={p} onNavigate={onNavigate} onUpdateProject={onUpdateProject} isLast={true} />
                ))}
              </div>
            )}
          </div>

          {/* En attente */}
          <div>
            <button onClick={() => setWaitingCollapsed(v => !v)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", background: "none", border: "none", padding: 0, marginBottom: 16, cursor: "pointer", fontFamily: "inherit" }}>
              <span style={{ display: "flex", alignItems: "center", color: T.textMuted, transform: waitingCollapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s" }}><IC.Chevron /></span>
              <span style={{ fontSize: 18, fontWeight: 800, color: T.textPrimary, letterSpacing: -0.4 }}>En attente de retour</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: T.accentText, background: T.accentBg, borderRadius: 999, padding: "2px 10px", marginLeft: 4 }}>{waiting.length}</span>
            </button>
            {!waitingCollapsed && (
              waiting.length === 0 ? (
                <div style={{ fontSize: 13, color: T.textMuted, textAlign: "center", padding: "20px 0" }}>Aucune attente en cours 🎉</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
    </div>
  );
}

// ─── APP (with persistent storage) ───────────────────────────────────────────
// ─── CLIENT SWITCHER (menu à deux niveaux dans la nav rail) ───────────────────
// ─── LOGO : pile de tickets dans un cercle ───────────────────────────────────
const TICKET_PATH = "M16 22a3 3 0 013-3h26a3 3 0 013 3v3a3.5 3.5 0 000 7v3a3 3 0 01-3 3H19a3 3 0 01-3-3v-3a3.5 3.5 0 000-7z";
function LogoMark({ size = 36 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" style={{ display: "block" }}>
      <circle cx="32" cy="32" r="31" fill="#1C1C1E" stroke="rgba(255,255,255,0.14)" strokeWidth="2" />
      <g transform="rotate(12 32 32)"><path d={TICKET_PATH} fill="#7550E3" /></g>
      <g transform="rotate(-8 32 32) translate(0 7)"><path d={TICKET_PATH} fill="#FFFFFF" /></g>
    </svg>
  );
}

// ─── CLIENT MODAL (création / édition — nom, couleur ou logo) ────────────────
const CLIENT_COLORS = ["#7550E3", "#DC2626", "#D97706", "#16A34A", "#0891B2", "#7C3AED", "#DB2777", "#6B7280"];

function ClientModal({ mode, initialClient, onSave, onClose }) {
  const [name, setName] = useState(initialClient?.name || "");
  const [color, setColor] = useState(initialClient?.color || CLIENT_COLORS[0]);
  const [logoDataUrl, setLogoDataUrl] = useState(initialClient?.logoDataUrl || null);

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { alert("Merci de choisir un fichier image."); return; }
    const reader = new FileReader();
    reader.onload = ev => setLogoDataUrl(ev.target.result);
    reader.readAsDataURL(file);
  }

  function handleSave() {
    if (!name.trim()) return;
    onSave({ name: name.trim(), color: logoDataUrl ? null : color, logoDataUrl });
    onClose();
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(31,29,54,0.40)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ background: T.bgCard, border: "none", borderRadius: 26, padding: 30, width: 360, maxWidth: "90vw", boxShadow: T.shadowPop }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.textPrimary }}>{mode === "create" ? "Nouveau client" : "Modifier le client"}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 4 }}><IC.X /></button>
        </div>

        {/* Aperçu */}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: logoDataUrl ? "transparent" : color, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", boxShadow: "0 4px 12px rgba(0,0,0,0.12)" }}>
            {logoDataUrl
              ? <img src={logoDataUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", borderRadius: "inherit" }} />
              : <span style={{ color: "#fff", fontSize: 22, fontWeight: 800 }}>{name?.[0]?.toUpperCase() || "?"}</span>}
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, display: "block", marginBottom: 8 }}>Nom du client</label>
          <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && handleSave()} placeholder="Ex: SFR" style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 7, color: T.textPrimary, fontSize: 13, outline: "none", fontFamily: "inherit" }} />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, display: "block", marginBottom: 8 }}>Couleur</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {CLIENT_COLORS.map(c => (
              <button key={c} onClick={() => { setColor(c); setLogoDataUrl(null); }} style={{ width: 26, height: 26, borderRadius: "50%", background: c, border: (!logoDataUrl && color === c) ? `2px solid ${T.textPrimary}` : "2px solid transparent", boxShadow: (!logoDataUrl && color === c) ? "0 0 0 2px #fff inset" : "none", cursor: "pointer", padding: 0 }} />
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, display: "block", marginBottom: 8 }}>Ou un logo depuis tes fichiers</label>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ flex: 1, textAlign: "center", padding: "8px 10px", borderRadius: 7, border: `1px solid ${T.border}`, background: T.bgInput, color: T.textSecondary, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              {logoDataUrl ? "Changer l'image" : "Choisir une image…"}
              <input type="file" accept="image/*" onChange={handleFile} style={{ display: "none" }} />
            </label>
            {logoDataUrl && (
              <button onClick={() => setLogoDataUrl(null)} style={{ padding: "8px 12px", borderRadius: 7, border: `1px solid ${T.border}`, background: "transparent", color: "#C5221F", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Retirer</button>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ height: 46, padding: "0 22px", borderRadius: 14, fontSize: 14, fontWeight: 600, background: T.bgInput, border: `1px solid ${T.border}`, color: T.textSecondary, cursor: "pointer" }}>Annuler</button>
          <button onClick={handleSave} style={{ height: 46, padding: "0 24px", borderRadius: 14, fontSize: 14, fontWeight: 700, background: T.accent, border: "none", color: "#fff", cursor: "pointer", boxShadow: "0 8px 18px rgba(117,80,227,0.28)" }}>{mode === "create" ? "Créer" : "Enregistrer"}</button>
        </div>
      </div>
    </div>
  );
}

function ClientSwitcher({ clients, projects, activeClientId, onSwitch, onRename, onCreate, onArchive, onUnarchive, onDeletePermanently }) {
  const [open, setOpen] = useState(false);
  const [editingClient, setEditingClient] = useState(null); // client en cours d'édition, ou "new"
  const [confirmArchiveId, setConfirmArchiveId] = useState(null);
  const [confirmDeletePermanentId, setConfirmDeletePermanentId] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const activeClient = clients.find(c => c.id === activeClientId) || clients[0];
  const visibleClients = clients.filter(c => !c.archived);
  const archivedClients = clients.filter(c => c.archived);

  function Avatar({ client, size = 18, radius = 5 }) {
    if (client?.logoDataUrl) {
      return <span style={{ width: size, height: size, borderRadius: radius, overflow: "hidden", flexShrink: 0, display: "flex" }}><img src={client.logoDataUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", borderRadius: "inherit" }} /></span>;
    }
    return <span style={{ width: size, height: size, borderRadius: radius, background: client?.color || T.accent, color: "#fff", fontSize: size * 0.55, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{client?.name?.[0]?.toUpperCase() || "?"}</span>;
  }

  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen(v => !v)} title={activeClient?.name} style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", boxSizing: "border-box", padding: "10px 12px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 16, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
        <Avatar client={activeClient} size={34} radius={11} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 11, fontWeight: 500, color: T.textMuted }}>Client</span>
          <span style={{ display: "block", fontSize: 14, fontWeight: 700, color: T.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeClient?.name}</span>
        </span>
        <span style={{ display: "flex", color: T.textMuted, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}><IC.Chevron /></span>
      </button>

      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 98 }} onClick={() => { setOpen(false); setShowArchived(false); }} />
          <div style={{ position: "absolute", top: "calc(100% + 8px)", left: 0, zIndex: 99, background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 18, boxShadow: T.shadowPop, width: 288, overflow: "hidden" }}>
            <div style={{ padding: "12px 14px 10px", fontSize: 12, fontWeight: 700, color: T.textMuted, borderBottom: `1px solid ${T.border}` }}>Choisir un client</div>

            {visibleClients.map(c => (
              <div key={c.id} style={{ display: "flex", alignItems: "center", background: c.id === activeClientId ? T.bgSelected : "transparent" }}>
                <button onClick={() => { onSwitch(c.id); setOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, textAlign: "left", padding: "11px 14px", background: "transparent", border: "none", cursor: "pointer", fontSize: 14, fontWeight: c.id === activeClientId ? 700 : 600, color: T.textPrimary }}>
                  <Avatar client={c} size={26} radius={8} />
                  {c.name}
                </button>
                <button onClick={() => setEditingClient(c)} title="Éditer" style={{ width: 24, height: 24, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", cursor: "pointer", color: T.textMuted, borderRadius: 5 }}
                  onMouseEnter={ev => { ev.currentTarget.style.background = T.bgHover; ev.currentTarget.style.color = T.textPrimary; }}
                  onMouseLeave={ev => { ev.currentTarget.style.background = "transparent"; ev.currentTarget.style.color = T.textMuted; }}>
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M8.5 1.5l2 2-6 6-2.4.4.4-2.4 6-6z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
                {visibleClients.length > 1 && (
                  <button onClick={() => setConfirmArchiveId(c.id)} title="Archiver ce client" style={{ width: 24, height: 24, flexShrink: 0, marginRight: 6, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", cursor: "pointer", color: T.textMuted, borderRadius: 5 }}
                    onMouseEnter={ev => { ev.currentTarget.style.background = T.bgHover; ev.currentTarget.style.color = T.textPrimary; }}
                    onMouseLeave={ev => { ev.currentTarget.style.background = "transparent"; ev.currentTarget.style.color = T.textMuted; }}>
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="2" width="11" height="3" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M2.3 5v6a1 1 0 001 1h7.4a1 1 0 001-1V5" stroke="currentColor" strokeWidth="1.2"/><path d="M5.5 7.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                  </button>
                )}
              </div>
            ))}

            <div style={{ borderTop: `1px solid ${T.border}` }}>
              <button onClick={() => setEditingClient("new")} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "8px 10px", background: "transparent", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, color: T.accent }}>
                <IC.Plus /> Nouveau client
              </button>
            </div>

            {archivedClients.length > 0 && (
              <div style={{ borderTop: `1px solid ${T.border}` }}>
                <button onClick={() => setShowArchived(v => !v)} style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", padding: "8px 10px", background: "transparent", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, color: T.textMuted }}>
                  <span style={{ display: "flex", transform: showArchived ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }}><IC.Chevron /></span>
                  Archivés ({archivedClients.length})
                </button>
                {showArchived && archivedClients.map(c => (
                  <div key={c.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px 6px 24px" }}>
                    <span style={{ fontSize: 12, color: T.textMuted, display: "flex", alignItems: "center", gap: 6 }}><Avatar client={c} size={16} /> {c.name}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      <button onClick={() => onUnarchive(c.id)} style={{ fontSize: 11, fontWeight: 700, color: T.accent, background: "transparent", border: "none", cursor: "pointer", padding: "3px 6px" }}>Désarchiver</button>
                      <button onClick={() => setConfirmDeletePermanentId(c.id)} title="Supprimer définitivement" style={{ width: 22, height: 22, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", cursor: "pointer", color: T.textXMuted, borderRadius: 5 }}
                        onMouseEnter={ev => { ev.currentTarget.style.background = "#FCE8E6"; ev.currentTarget.style.color = "#C5221F"; }}
                        onMouseLeave={ev => { ev.currentTarget.style.background = "transparent"; ev.currentTarget.style.color = T.textXMuted; }}>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 3.5h7M4.5 3.5V2.3a.8.8 0 01.8-.8h1.4a.8.8 0 01.8.8v1.2M5 5.5v3M7 5.5v3M3.2 3.5l.4 6a1 1 0 001 .9h2.8a1 1 0 001-.9l.4-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {editingClient && (
        <ClientModal
          mode={editingClient === "new" ? "create" : "edit"}
          initialClient={editingClient === "new" ? null : editingClient}
          onClose={() => setEditingClient(null)}
          onSave={(data) => {
            if (editingClient === "new") onCreate(data);
            else onRename(editingClient.id, data);
          }}
        />
      )}

      {confirmArchiveId && (() => {
        const target = clients.find(c => c.id === confirmArchiveId);
        return (
          <ConfirmModal
            title={`Archiver le client "${target?.name}" ?`}
            message="Il disparaîtra de la liste, mais ses sujets restent intacts — tu pourras tout retrouver en le désarchivant."
            confirmLabel="Archiver"
            onCancel={() => setConfirmArchiveId(null)}
            onConfirm={() => {
              onArchive(confirmArchiveId);
              setConfirmArchiveId(null);
              setOpen(false);
            }}
          />
        );
      })()}

      {confirmDeletePermanentId && (() => {
        const target = clients.find(c => c.id === confirmDeletePermanentId);
        const count = (projects || []).filter(p => p.clientId === confirmDeletePermanentId).length;
        return (
          <ConfirmModal
            title={`Supprimer définitivement "${target?.name}" ?`}
            message={`Action irréversible : ${count} sujet${count > 1 ? "s" : ""} et tout leur historique seront supprimés pour toujours, sans possibilité de retour.`}
            confirmLabel="Supprimer définitivement"
            onCancel={() => setConfirmDeletePermanentId(null)}
            onConfirm={() => {
              onDeletePermanently(confirmDeletePermanentId);
              setConfirmDeletePermanentId(null);
              setOpen(false);
            }}
          />
        );
      })()}
    </div>
  );
}

// Prénom de la personne connectée (affiché à côté de son avatar dans la barre latérale)
function AccountName() {
  const { user } = useUser();
  return <span style={{ fontSize: 13, fontWeight: 600, color: T.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user?.firstName || "Mon compte"}</span>;
}

function AppContent() {
  const [projects, setProjects] = useState(null);
  const [clients, setClients] = useState([{ id: "c1", name: "SFR" }]);
  const [activeClientId, setActiveClientId] = useState("c1");
  const [activePage, setActivePage] = useState("dashboard");
  const [targetProjectId, setTargetProjectId] = useState(null);
  const [saveStatus, setSaveStatus] = useState("idle");
  const [incomingSync, setIncomingSync] = useState(null); // { projectId, activities }
  const syncPollRef = useRef(null);

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
        const [sujetRecords, activiteRecords, tempsRecords, clientRecords] = await Promise.all([
          airtableListAll(AIRTABLE_TABLE_SUJET),
          airtableListAll(AIRTABLE_TABLE_ACTIVITE),
          airtableListAll(AIRTABLE_TABLE_TEMPS),
          airtableListAll(AIRTABLE_TABLE_CLIENT),
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

        // Une seule ligne "Temps" par sujet + semaine. S'il y a des doublons (anciens clics rapides), la plus récente fait foi.
        const bestTemps = {};
        let duplicateRows = 0;
        tempsRecords.forEach(r => {
          const f = r.fields || {};
          const semaine = String(f["Semaine"] || "").slice(0, 10);
          if (!semaine) return;
          (f["Sujet"] || []).forEach(sujetId => {
            if (!projectsById[sujetId]) return;
            const key = `${sujetId}|${semaine}`;
            if (bestTemps[key]) duplicateRows++;
            if (!bestTemps[key] || String(r.createdTime || "") > String(bestTemps[key].r.createdTime || "")) bestTemps[key] = { sujetId, semaine, r };
          });
        });
        Object.values(bestTemps).forEach(({ sujetId, semaine, r }) => {
          const p = projectsById[sujetId];
          if (!p.weeklyTime) p.weeklyTime = {};
          if (!p._weeklyTimeRecordIds) p._weeklyTimeRecordIds = {};
          p.weeklyTime[semaine] = r.fields["Temps travaillé"] || 0;
          p._weeklyTimeRecordIds[semaine] = r.id;
        });
        if (duplicateRows > 0) console.warn(`[Airtable] ${duplicateRows} ligne(s) en double dans la table "Temps" (même sujet et même semaine) : la plus récente est utilisée. Tu peux supprimer les autres dans Airtable.`);

        Object.values(projectsById).forEach(p => { p.timeline = sortEntries(p.timeline, "asc"); p.lastActivity = latestDate(p.timeline) || p.lastActivity; });

        const loadedClients = clientRecords.map(airtableFieldsToClient);
        setClients(loadedClients);

        // À l'arrivée, le client affiché est toujours SFR (et non le dernier client consulté)
        setActiveClientId(pickDefaultClient(loadedClients)?.id || null);

        setProjects(Object.values(projectsById));
      } catch (e) {
        setAirtableError(e.message || String(e));
        setProjects([]);
      }
    }
    load();
  }, []);

  // ── Synchronisation Airtable ──
  // File d'attente : une seule écriture Airtable à la fois par sujet (les écritures ne se chevauchent plus)
  const syncChainRef = useRef({});
  // Lignes de la table "Temps" déjà créées : "idSujet|semaine" → id Airtable.
  // Indispensable pour les clics rapides sur le compteur : le 2e clic doit MODIFIER la ligne du 1er, pas en créer une autre.
  const timeRowRef = useRef({});
  // Id temporaire d'une activité créée dans l'interface → id réel donné par Airtable
  const realIdRef = useRef({});
  const realId = (tid) => realIdRef.current[tid] || tid;

  function reportSyncError(context, err) {
    console.error(`[Airtable] ${context}`, err);
    setAirtableError(`${context}\n${err?.message || String(err)}`.slice(0, 900));
    setSaveStatus("error");
  }

  async function syncProjectChange(prevProject, id, changes) {
    const { timeline, weeklyTime, ...projectChanges } = changes;
    let failed = false;

    // 1) Activités — en premier : c'est la donnée la plus précieuse, elle ne dépend plus des autres champs
    if (timeline) {
      try {
        const nextIds = new Set(timeline.map(e => realId(e.id)));
        for (const e of (prevProject.timeline || [])) {
          if (!nextIds.has(realId(e.id))) {
            // Un enregistrement déjà supprimé (404) n'est pas une erreur
            await airtableDelete(AIRTABLE_TABLE_ACTIVITE, realId(e.id)).catch(err => {
              if (!String(err?.message).includes("Airtable 404")) throw err;
            });
          }
        }
        for (const e of timeline) {
          const prevEntry = (prevProject.timeline || []).find(pe => realId(pe.id) === realId(e.id));
          if (!prevEntry) {
            const created = await airtableCreate(AIRTABLE_TABLE_ACTIVITE, activityToAirtableFields(e, id));
            realIdRef.current[e.id] = created.id;
            // On remplace uniquement l'id : l'horodatage local est conservé (et déjà écrit dans Airtable)
            setProjects(prev => prev.map(p => p.id === id
              ? { ...p, timeline: p.timeline.map(te => te.id === e.id ? { ...te, id: created.id } : te) }
              : p
            ));
          } else if (JSON.stringify({ ...prevEntry, id: realId(prevEntry.id) }) !== JSON.stringify({ ...e, id: realId(e.id) })) {
            await airtableUpdate(AIRTABLE_TABLE_ACTIVITE, realId(e.id), activityToAirtableFields(e, id));
          }
        }
      } catch (err) {
        failed = true;
        reportSyncError("Activité non enregistrée dans Airtable", err);
      }
    }

    // 2) Champs du sujet — uniquement ceux qui ont changé
    const sujetFields = changedSujetFields({ ...prevProject, ...projectChanges }, Object.keys(projectChanges));
    if (Object.keys(sujetFields).length > 0) {
      try {
        await airtableUpdate(AIRTABLE_TABLE_SUJET, id, sujetFields);
      } catch (err) {
        failed = true;
        reportSyncError("Sujet non enregistré dans Airtable", err);
      }
    }

    // 3) Temps passé : une ligne par sujet + par semaine dans la table "Temps"
    if (weeklyTime) {
      try {
        const prevWT = prevProject.weeklyTime || {};
        for (const week of Object.keys(weeklyTime)) {
          if (weeklyTime[week] === prevWT[week]) continue;
          const key = `${id}|${week}`;
          const rowId = timeRowRef.current[key] || prevProject._weeklyTimeRecordIds?.[week];
          if (rowId) {
            await airtableUpdate(AIRTABLE_TABLE_TEMPS, rowId, { "Temps travaillé": weeklyTime[week] });
            timeRowRef.current[key] = rowId;
          } else {
            const created = await airtableCreate(AIRTABLE_TABLE_TEMPS, {
              "Sujet": [id],
              "Semaine": week,
              "Temps travaillé": weeklyTime[week],
            });
            timeRowRef.current[key] = created.id;
            setProjects(prev => prev.map(p => p.id === id
              ? { ...p, _weeklyTimeRecordIds: { ...(p._weeklyTimeRecordIds || {}), [week]: created.id } }
              : p
            ));
          }
        }
      } catch (err) {
        failed = true;
        reportSyncError("Temps passé non enregistré dans Airtable", err);
      }
    }

    if (!failed) {
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 1500);
    }
  }

  // ── Actions ──
  function updateProject(id, changes) {
    const prevProject = projects.find(p => p.id === id);
    // Répare les ids temporaires d'activités dans un historique devenu périmé (ex. pendant un appel IA)
    if (changes.timeline) {
      changes = { ...changes, timeline: changes.timeline.map(e => realIdRef.current[e.id] ? { ...e, id: realIdRef.current[e.id] } : e) };
    }
    // Changement de statut hors Kanban : la carte arrive en haut de sa nouvelle colonne
    if (prevProject && changes.status && changes.status !== prevProject.status && changes.order === undefined) {
      changes = { ...changes, order: topOrderFor(projects, changes.status, id) };
    }
    setProjects(prev => prev.map(p => p.id === id ? { ...p, ...changes } : p));
    if (prevProject) {
      setSaveStatus("saving");
      const previous = syncChainRef.current[id] || Promise.resolve();
      syncChainRef.current[id] = previous.then(() => syncProjectChange(prevProject, id, changes));
    }
  }

  // Plusieurs sujets modifiés d'un coup (réorganisation du Kanban) : une seule requête Airtable groupée
  function reorderProjects(changesById) {
    const ids = Object.keys(changesById);
    if (ids.length === 0) return;
    setProjects(prev => prev.map(p => changesById[p.id] ? { ...p, ...changesById[p.id] } : p));
    setSaveStatus("saving");
    // On attend la fin des écritures déjà en cours sur ces sujets, puis on enregistre
    const pending = Promise.all(ids.map(id => syncChainRef.current[id] || Promise.resolve()));
    const job = pending.then(async () => {
      try {
        const records = ids.map(id => {
          const base = projects.find(p => p.id === id) || {};
          return { id, fields: changedSujetFields({ ...base, ...changesById[id] }, Object.keys(changesById[id])) };
        });
        await airtableBatchUpdate(AIRTABLE_TABLE_SUJET, records);
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 1500);
      } catch (err) {
        reportSyncError("Ordre des cartes non enregistré dans Airtable", err);
      }
    });
    ids.forEach(id => { syncChainRef.current[id] = job; });
  }

  function deleteActivityGlobal(entryId) {
    // La suppression Airtable se fait déjà dans syncProjectChange via le diff de timeline.
  }

  async function addProject(project) {
    setSaveStatus("saving");
    try {
      const order = topOrderFor(projects, project.status || "in_progress", null);   // nouveau sujet : en haut de sa colonne
      const created = await airtableCreate(AIRTABLE_TABLE_SUJET, projectToAirtableFields({ ...project, clientId: activeClientId, order }));
      const newProject = { ...project, id: created.id, clientId: activeClientId, order, createdAt: created.createdTime, timeline: [] };
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

  // ── Gestion des clients (Airtable) ──
  function switchClient(clientId) {
    setActiveClientId(clientId);
  }

  async function renameClient(clientId, updates) {
    setClients(prev => prev.map(c => c.id === clientId ? { ...c, ...updates } : c));
    try {
      await airtableUpdate(AIRTABLE_TABLE_CLIENT, clientId, clientToAirtableFields({ ...clients.find(c => c.id === clientId), ...updates }));
    } catch (e) {
      setAirtableError(e.message || String(e));
    }
  }

  async function createClient(data) {
    try {
      const created = await airtableCreate(AIRTABLE_TABLE_CLIENT, clientToAirtableFields(data));
      const newClient = airtableFieldsToClient(created);
      setClients(prev => [...prev, newClient]);
      switchClient(newClient.id);
    } catch (e) {
      setAirtableError(e.message || String(e));
    }
  }

  async function archiveClient(clientId) {
    const activeCount = clients.filter(c => !c.archived).length;
    const target = clients.find(c => c.id === clientId);
    if (!target || target.archived) return;
    if (activeCount <= 1) return; // toujours garder au moins un client actif

    setClients(prev => prev.map(c => c.id === clientId ? { ...c, archived: true } : c));
    if (activeClientId === clientId) {
      const fallback = clients.find(c => c.id !== clientId && !c.archived);
      if (fallback) switchClient(fallback.id);
    }
    try {
      await airtableUpdate(AIRTABLE_TABLE_CLIENT, clientId, { "Archivé": true });
    } catch (e) {
      setAirtableError(e.message || String(e));
    }
  }

  async function unarchiveClient(clientId) {
    setClients(prev => prev.map(c => c.id === clientId ? { ...c, archived: false } : c));
    try {
      await airtableUpdate(AIRTABLE_TABLE_CLIENT, clientId, { "Archivé": false });
    } catch (e) {
      setAirtableError(e.message || String(e));
    }
  }

  async function deleteClientPermanently(clientId) {
    const affectedProjects = projects.filter(p => p.clientId === clientId);
    setClients(prev => prev.filter(c => c.id !== clientId));
    setProjects(prev => prev.filter(p => p.clientId !== clientId));
    try {
      for (const p of affectedProjects) {
        await Promise.all((p.timeline || []).map(e => airtableDelete(AIRTABLE_TABLE_ACTIVITE, e.id).catch(() => {})));
        await airtableDelete(AIRTABLE_TABLE_SUJET, p.id).catch(() => {});
      }
      await airtableDelete(AIRTABLE_TABLE_CLIENT, clientId);
    } catch (e) {
      setAirtableError(e.message || String(e));
    }
  }

  const visibleProjects = useMemo(
    () => (projects || []).filter(p => p.clientId === activeClientId),
    [projects, activeClientId]
  );

  // ── Loading state ──
  if (projects === null) {
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: T.bg, fontFamily: T.font }}>
        <div style={{ textAlign: "center", color: T.textMuted }}>
          <div style={{ width: 36, height: 36, margin: "0 auto 16px" }}>
            <LogoMark size={36} />
          </div>
          <div style={{ fontSize: 13, color: T.textMuted }}>Chargement…</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100vh", background: T.bg, fontFamily: T.font, color: T.textPrimary, overflow: "hidden" }}>
      <style>{"@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap'); * { -webkit-font-smoothing: antialiased; } button, input, textarea, select { font-family: inherit; } ::selection { background: #E3D9FF; }"}</style>
      {/* ── BARRE LATÉRALE ── */}
      <nav style={{ width: 248, flexShrink: 0, background: T.bgSidebar, borderRight: `1px solid ${T.border}`, display: "flex", flexDirection: "column", padding: "26px 18px 18px", boxSizing: "border-box", zIndex: 10 }}>
        {/* Marque */}
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "0 6px", marginBottom: 24 }}>
          <LogoMark size={36} />
          <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: -0.3, color: T.textPrimary }}>Project tracker</span>
        </div>

        <ClientSwitcher clients={clients} projects={projects} activeClientId={activeClientId} onSwitch={switchClient} onRename={renameClient} onCreate={createClient} onArchive={archiveClient} onUnarchive={unarchiveClient} onDeletePermanently={deleteClientPermanently} />

        {/* Navigation */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 22, flex: 1 }}>
          {NAV_ITEMS.filter(item => item.available).map(item => {
            const active = activePage === item.id;
            return (
              <button key={item.id} onClick={() => setActivePage(item.id)} title={item.label}
                style={{ display: "flex", alignItems: "center", gap: 14, width: "100%", boxSizing: "border-box", height: 48, padding: "0 16px", border: "none", borderRadius: 14, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600, textAlign: "left", background: active ? T.accent : "transparent", color: active ? "#FFFFFF" : T.textMuted, boxShadow: active ? "0 8px 18px rgba(117,80,227,0.30)" : "none", transition: "background 0.15s, color 0.15s" }}
                onMouseEnter={e => { if (!active) { e.currentTarget.style.background = T.bgHover; e.currentTarget.style.color = T.textPrimary; } }}
                onMouseLeave={e => { if (!active) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.textMuted; } }}>
                {item.icon(active)}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* Outils : export, import, état de la sauvegarde */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2, borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
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
            style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", boxSizing: "border-box", height: 40, padding: "0 14px", borderRadius: 12, background: "transparent", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 13, fontWeight: 600, fontFamily: "inherit", textAlign: "left" }}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 9V1M7 1l-3 3M7 1l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 11v1.5a1 1 0 001 1h8a1 1 0 001-1V11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
            <span>Exporter</span>
          </button>
          <label title="Importer une sauvegarde JSON" style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", boxSizing: "border-box", height: 40, padding: "0 14px", borderRadius: 12, background: "transparent", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 13, fontWeight: 600, fontFamily: "inherit", textAlign: "left" }}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M7 9l-3-3M7 9l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 11v1.5a1 1 0 001 1h8a1 1 0 001-1V11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
            <span>Importer</span>
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
                      const created = await airtableCreate(AIRTABLE_TABLE_SUJET, projectToAirtableFields({ ...p, clientId: activeClientId }));
                      const newTimeline = [];
                      for (const entry of (p.timeline || [])) {
                        const createdEntry = await airtableCreate(AIRTABLE_TABLE_ACTIVITE, activityToAirtableFields(entry, created.id));
                        newTimeline.push({ ...entry, id: createdEntry.id, createdAt: createdEntry.createdTime });
                      }
                      imported.push({ ...p, id: created.id, clientId: activeClientId, createdAt: created.createdTime, timeline: newTimeline });
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
          <div style={{ display: "flex", alignItems: "center", gap: 12, height: 32, padding: "0 14px", fontSize: 12, fontWeight: 500, color: T.textMuted }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: saveStatus === "saved" ? "#2DA66A" : saveStatus === "saving" ? "#E08E1F" : saveStatus === "error" ? "#E5484D" : T.textXMuted, transition: "background 0.3s" }} title={saveStatus === "saved" ? "Sauvegardé" : saveStatus === "saving" ? "Sauvegarde…" : saveStatus === "error" ? "Erreur de sauvegarde" : "Synchronisé"} />
            <span>{saveStatus === "saved" ? "Enregistré" : saveStatus === "saving" ? "Enregistrement…" : saveStatus === "error" ? "Erreur d'enregistrement" : "À jour"}</span>
          </div>
        </div>

        {/* Compte (Clerk) */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 8px 0" }}>
          <UserButton appearance={{ elements: { avatarBox: { width: 34, height: 34 } } }} />
          <AccountName />
        </div>
      </nav>

      {/* ── PAGE ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", background: T.bg, minWidth: 0 }}>
        {activePage === "projects"  && <SubjectsPage projects={visibleProjects} onUpdate={updateProject} onAdd={addProject} onDelete={deleteProject} onDeleteActivity={deleteActivityGlobal} targetProjectId={targetProjectId} onTargetConsumed={() => setTargetProjectId(null)} incomingSync={incomingSync} onSyncConsumed={() => setIncomingSync(null)} />}
        {activePage === "kanban"    && <KanbanPage projects={visibleProjects} onUpdate={updateProject} onReorder={reorderProjects} onDelete={deleteProject} onDeleteActivity={deleteActivityGlobal} incomingSync={incomingSync} onSyncConsumed={() => setIncomingSync(null)} />}
        {activePage === "activity"  && <ActivityPage projects={visibleProjects} onUpdateProject={updateProject} onNavigate={(page, id) => { setTargetProjectId(id || null); setActivePage(page); }} />}
        {activePage === "dashboard" && <DashboardPage projects={visibleProjects} onUpdateProject={updateProject} onNavigate={(page, id) => { setTargetProjectId(id || null); setActivePage(page); }} />}
        {activePage === "settings"  && <PlaceholderPage label="Réglages" />}
      </div>

      {airtableError && (
        <div style={{ position: "fixed", left: "50%", bottom: 20, transform: "translateX(-50%)", zIndex: 1100, width: "min(720px, 92vw)", boxSizing: "border-box", background: "#7F1D1D", color: "#fff", borderRadius: 16, padding: "14px 18px", boxShadow: T.shadowPop, display: "flex", gap: 12, alignItems: "flex-start", fontSize: 12.5, lineHeight: 1.45 }}>
          <div style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            <div style={{ fontWeight: 700, marginBottom: 3 }}>Enregistrement Airtable impossible</div>
            {airtableError}
          </div>
          <button onClick={() => setAirtableError(null)} style={{ flexShrink: 0, background: "rgba(255,255,255,0.16)", border: "none", color: "#fff", borderRadius: 6, padding: "4px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Fermer</button>
        </div>
      )}
    </div>
  );
}

// ─── Point d'entrée réel : bloque l'accès tant que la personne n'est pas connectée ──
export default function App() {
  return (
    <>
      <SignedOut>
        <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: T.bg, fontFamily: T.font }}>
          <SignIn />
        </div>
      </SignedOut>
      <SignedIn>
        <AppContent />
      </SignedIn>
    </>
  );
}
