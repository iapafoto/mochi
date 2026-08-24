// File des déplacements MESURÉS — ce qui permet d'enchaîner « avance vite, puis
// recule lentement ».
//
// LE PROBLÈME QU'ELLE RÉSOUT. Gemini émet ses function calls d'un bloc : les deux
// ordres arrivent au dispatcher à la même milliseconde. Or côté firmware un
// déplacement mesuré n'est pas empilable — `startOdoMove` écrase la cible en cours
// (c'est volontaire : c'est ce qui permet de reprendre la main sur un robot parti
// pour 2 m). Envoyés tels quels, le second ordre ANNULE donc le premier, en
// silence, et le robot ne fait que reculer. Rien dans le journal ne le dit.
//
// LA DIFFICULTÉ. Un déplacement mesuré termine sur l'ODOMÉTRIE : sa durée n'est
// connue à l'avance de personne — ni de l'app, ni du robot. Il n'y a donc pas de
// chronomètre juste à attendre ; il faut que le robot DISE quand il a fini. C'est
// TELEM_FLAG_MOVING (protocol.h), qui couvre trajet + stabilisation.
//
// CE QU'ELLE NE FAIT PAS : des trajectoires. Deux ordres à la suite restent deux
// ordres, séparés par un arrêt complet et une stabilisation (~1,5 s). Pour une
// courbe continue, c'est DriveLoop.

import type { Transport } from './transport';

/** Un déplacement en attente. */
interface QueuedMove {
  op: number;
  /** cm ou degrés, selon l'opcode. */
  value: number;
  /** Allure en % de la croisière (cf. protocol.h). */
  pct: number;
  /** Ce qu'on affichera au journal au moment où il partira vraiment. */
  label: string;
}

/**
 * Plafond de la file. Un modèle qui décide d'enchaîner huit manœuvres sur une
 * table n'a pas une meilleure idée que nous de ce qu'il y a au bord ; deux ou
 * trois temps, c'est ce qu'on demande à un robot qui fait son numéro.
 */
const MAX_QUEUED = 3;

/**
 * Respiration entre deux déplacements. Le firmware s'est déjà stabilisé 1,5 s,
 * donc ce n'est pas de la sécurité : c'est de la lisibilité. Deux mouvements
 * collés se lisent comme un seul mouvement bizarre.
 */
const GAP_MS = 350;

/**
 * Délai au bout duquel on considère que le robot n'a jamais démarré. La
 * télémétrie arrive à 10 Hz et le drapeau monte au premier tick : 1,2 s est
 * généreux. Sans ce garde-fou, un ordre perdu (ou refusé côté firmware, ce qu'il
 * fait en silence) laisserait la file bloquée pour toujours.
 */
const START_TIMEOUT_MS = 1200;

/** Garde-fou de fin. Le budget firmware le plus long dépasse rarement 15 s. */
const RUN_TIMEOUT_MS = 25000;

export interface MoveQueueDeps {
  /**
   * Le robot est-il occupé par un déplacement mesuré ? `null` = on n'en sait rien
   * (pas connecté, pas encore de télémétrie) — la file passe alors en aveugle.
   */
  isMoving(): boolean | null;
  /**
   * Le déplacement est-il encore possible ? Rend la raison du refus, ou null.
   * ⚠️ RÉÉVALUÉ AU MOMENT OÙ CHAQUE ORDRE PART, pas à la mise en file : entre
   * « avance » et « recule » le robot a eu tout le loisir de tomber, et rejouer
   * la suite sur un robot couché ne ferait qu'ajouter des ordres avalés.
   */
  gate(): string | null;
  log(line: string): void;
}

export class MoveQueue {
  private readonly pending: QueuedMove[] = [];
  private current: QueuedMove | null = null;
  private startedAtMs = 0;
  private sawMoving = false;
  private timer: number | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly deps: MoveQueueDeps,
  ) {}

  get busy(): boolean {
    return this.current !== null || this.pending.length > 0;
  }

  /**
   * Met un déplacement en file. Rend false s'il est refusé (file pleine) — le
   * dispatcher le remonte alors comme n'importe quel autre refus.
   */
  enqueue(move: QueuedMove): boolean {
    if (this.pending.length >= MAX_QUEUED) {
      this.deps.log(`⚠ ${move.label} ignoré : déjà ${MAX_QUEUED} déplacements en attente`);
      return false;
    }
    this.pending.push(move);
    if (!this.current) this.pump();
    return true;
  }

  /**
   * Vide tout et oublie le déplacement en cours. Appelé par le STOP et par toute
   * préemption : un bouton d'arrêt qui laisserait la suite du programme repartir
   * trois secondes plus tard serait pire que pas de bouton du tout.
   */
  clear(): void {
    const dropped = this.pending.length;
    this.pending.length = 0;
    this.current = null;
    this.stopTimer();
    if (dropped) this.deps.log(`⏹ ${dropped} déplacement(s) en attente annulé(s)`);
  }

  /** Lance le prochain déplacement si le robot est libre. */
  private pump(): void {
    if (this.current || this.pending.length === 0) return;
    const next = this.pending.shift() as QueuedMove;

    const refus = this.deps.gate();
    if (refus) {
      // On jette AUSSI la suite : elle a été pensée comme un enchaînement, et ses
      // pas suivants n'ont pas plus de sens isolés que celui-ci.
      this.deps.log(`⚠ ${next.label} abandonné : ${refus}`);
      this.clear();
      return;
    }

    this.current = next;
    this.startedAtMs = Date.now();
    this.sawMoving = false;
    this.transport.sendIntent(next.op, next.value, next.pct);
    this.deps.log(`▷ ${next.label}`);
    this.startTimer();
  }

  private startTimer(): void {
    if (this.timer !== null) return;
    // Cadencé sur la télémétrie (10 Hz) : inutile d'interroger plus vite que la
    // seule source qui puisse changer d'avis.
    this.timer = window.setInterval(() => this.tick(), 100);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (!this.current) {
      this.stopTimer();
      return;
    }
    const elapsed = Date.now() - this.startedAtMs;
    const moving = this.deps.isMoving();

    // Aveugle (pas de robot au bout, ou télémétrie muette) : on ne bloque pas la
    // file pour autant. Le transport a déjà journalisé « non émis » et c'est là
    // que se lit la vraie cause ; ici on se contente de ne pas rester coincé.
    if (moving === null) {
      if (elapsed > START_TIMEOUT_MS) this.finish();
      return;
    }

    if (moving) {
      this.sawMoving = true;
      if (elapsed > RUN_TIMEOUT_MS) {
        this.deps.log('⚠ déplacement anormalement long — file vidée');
        this.clear();
      }
      return;
    }

    // Pas (encore) en mouvement. Deux cas très différents, et c'est `sawMoving`
    // qui les sépare : le drapeau est retombé APRÈS être monté ⇒ c'est fini ; il
    // n'est jamais monté ⇒ l'ordre n'a rien déclenché (firmware qui refuse en
    // silence, message perdu). Sans cette distinction, on enchaînerait aussitôt
    // sur le suivant en croyant le premier terminé — l'annulation muette qu'on
    // cherchait précisément à éviter.
    if (this.sawMoving) {
      this.finish();
      return;
    }
    if (elapsed > START_TIMEOUT_MS) {
      this.deps.log(`⚠ ${this.current.label} : le robot n'a pas démarré — suite annulée`);
      this.clear();
    }
  }

  /** Déplacement terminé : on souffle un peu, puis on enchaîne. */
  private finish(): void {
    this.current = null;
    this.stopTimer();
    if (this.pending.length === 0) return;
    window.setTimeout(() => this.pump(), GAP_MS);
  }
}
