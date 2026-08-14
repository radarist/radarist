import type { DesignTokens } from '../design-tokens';

export interface MermaidThemeVariables {
  fontFamily: string;
  primaryColor: string;
  primaryTextColor: string;
  primaryBorderColor: string;
  lineColor: string;
  secondaryColor: string;
  tertiaryColor: string;
  background: string;
  mainBkg: string;
  textColor: string;

  // Generic flowchart / cluster vars
  nodeBkg?: string;
  nodeBorder?: string;
  clusterBkg?: string;
  clusterBorder?: string;
  edgeLabelBackground?: string;
  defaultLinkColor?: string;
  titleColor?: string;

  // Per-fill palette (Mermaid uses fillType0..fillType7 for category coloring)
  fillType0?: string;
  fillType1?: string;
  fillType2?: string;
  fillType3?: string;
  fillType4?: string;
  fillType5?: string;
  fillType6?: string;
  fillType7?: string;

  // Note styling
  noteBkgColor?: string;
  noteTextColor?: string;
  noteBorderColor?: string;

  // Error styling
  errorBkgColor?: string;
  errorTextColor?: string;

  // Sequence diagram-specific
  actorBkg?: string;
  actorBorder?: string;
  actorTextColor?: string;
  actorLineColor?: string;
  signalColor?: string;
  signalTextColor?: string;
  labelBoxBkgColor?: string;
  labelBoxBorderColor?: string;
  labelTextColor?: string;
  loopTextColor?: string;
  activationBkgColor?: string;
  activationBorderColor?: string;
  sequenceNumberColor?: string;

  // Gantt-specific
  sectionBkgColor?: string;
  altSectionBkgColor?: string;
  gridColor?: string;
  doneTaskBkgColor?: string;
  doneTaskBorderColor?: string;
  activeTaskBkgColor?: string;
  activeTaskBorderColor?: string;
  critBkgColor?: string;
  critBorderColor?: string;
  taskTextColor?: string;
  taskTextOutsideColor?: string;
  taskTextLightColor?: string;
  todayLineColor?: string;
}

export function mermaidTheme(t: DesignTokens): MermaidThemeVariables {
  return {
    // Originals (preserved for backward compat)
    fontFamily: t.type.family,
    primaryColor: t.color.sequence[0],
    primaryTextColor: t.color.ink,
    primaryBorderColor: t.color.rule,
    lineColor: t.color.muted,
    secondaryColor: t.color.sequence[1],
    tertiaryColor: t.color.sequence[2],
    background: t.color.canvas,
    mainBkg: t.color.surface,
    textColor: t.color.ink,

    // Generic flowchart / cluster
    nodeBkg: t.color.surface,
    nodeBorder: t.color.rule,
    clusterBkg: t.color.canvas,
    clusterBorder: t.color.rule,
    edgeLabelBackground: t.color.canvas,
    defaultLinkColor: t.color.muted,
    titleColor: t.color.ink,

    // Per-fill palette
    fillType0: t.color.sequence[0],
    fillType1: t.color.sequence[1],
    fillType2: t.color.sequence[2],
    fillType3: t.color.sequence[3],
    fillType4: t.color.sequence[4],
    fillType5: t.color.sequence[5],
    fillType6: t.color.sequence[6],
    fillType7: t.color.sequence[7],

    // Note styling
    noteBkgColor: t.color.surface,
    noteTextColor: t.color.ink,
    noteBorderColor: t.color.rule,

    // Error styling
    errorBkgColor: t.color.surface,
    errorTextColor: t.color.negative,

    // Sequence-specific
    actorBkg: t.color.surface,
    actorBorder: t.color.rule,
    actorTextColor: t.color.ink,
    actorLineColor: t.color.muted,
    signalColor: t.color.ink,
    signalTextColor: t.color.ink,
    labelBoxBkgColor: t.color.canvas,
    labelBoxBorderColor: t.color.rule,
    labelTextColor: t.color.ink,
    loopTextColor: t.color.ink,
    activationBkgColor: t.color.sequence[0],
    activationBorderColor: t.color.ink,
    sequenceNumberColor: t.color.canvas,

    // Gantt-specific
    sectionBkgColor: t.color.canvas,
    altSectionBkgColor: t.color.surface,
    gridColor: t.color.rule,
    doneTaskBkgColor: t.color.muted,
    doneTaskBorderColor: t.color.rule,
    activeTaskBkgColor: t.color.sequence[0],
    activeTaskBorderColor: t.color.ink,
    critBkgColor: t.color.negative,
    critBorderColor: t.color.negative,
    taskTextColor: t.color.ink,
    taskTextOutsideColor: t.color.ink,
    taskTextLightColor: t.color.canvas,
    todayLineColor: t.color.sequence[1],
  };
}
