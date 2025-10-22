// Module: Mesocycles library - Shared training plan definitions
// This is the single source of truth for all mesocycle definitions

export const FIXED_PLAN_LIBRARY = [
  {
    id: "mesociclo-incorporacao",
    name: "Mesociclo de Incorporação",
    summary: "Introduzir o usuário ao treino isométrico de preensão, priorizando tolerância e controle respiratório durante esforços leves e curtos.",
    weeklyFrequency: 3, // Frequência sugerida: 3 sessões por semana
    stages: [
      { label: "Familiarização", durationSec: 60, restSec: 60, lowerPct: 0.15, upperPct: 0.18 },
      { label: "Controle leve", durationSec: 60, restSec: 60, lowerPct: 0.17, upperPct: 0.20 },
      { label: "Consistência inicial", durationSec: 60, restSec: 60, lowerPct: 0.18, upperPct: 0.21 },
    ],
  },
  {
    id: "mesociclo-basico",
    name: "Mesociclo Básico",
    summary: "Aprimorar a capacidade de sustentar isometria com estabilidade de força e respiração, desenvolvendo adaptação autonômica inicial.",
    weeklyFrequency: 3,
    stages: [
      { label: "Estabilidade leve", durationSec: 60, restSec: 60, lowerPct: 0.20, upperPct: 0.23 },
      { label: "Controle respiratório", durationSec: 60, restSec: 60, lowerPct: 0.22, upperPct: 0.25 },
      { label: "Sustentação moderada", durationSec: 60, restSec: 60, lowerPct: 0.24, upperPct: 0.27 },
    ],
  },
  {
    id: "mesociclo-estabilizador",
    name: "Mesociclo Estabilizador",
    summary: "Consolidar o controle pressórico e respiratório, reduzindo a variabilidade da força e aprimorando o equilíbrio autonômico.",
    weeklyFrequency: 3,
    stages: [
      { label: "Controle sustentado", durationSec: 60, restSec: 60, lowerPct: 0.23, upperPct: 0.27 },
      { label: "Estabilidade contínua", durationSec: 60, restSec: 60, lowerPct: 0.25, upperPct: 0.28 },
      { label: "Refinamento técnico", durationSec: 60, restSec: 60, lowerPct: 0.26, upperPct: 0.30 },
    ],
  },
  {
    id: "mesociclo-controle",
    name: "Mesociclo de Controle",
    summary: "Avaliar o progresso do controle pressórico e autonômico, ajustando a faixa de intensidade conforme a resposta do usuário.",
    weeklyFrequency: 3,
    stages: [
      { label: "Aquecimento leve", durationSec: 60, restSec: 60, lowerPct: 0.20, upperPct: 0.24 },
      { label: "Avaliação controlada", durationSec: 60, restSec: 60, lowerPct: 0.24, upperPct: 0.28 },
      { label: "Estabilidade máxima", durationSec: 60, restSec: 60, lowerPct: 0.27, upperPct: 0.30 },
    ],
  },
  {
    id: "mesociclo-pre-otimizacao",
    name: "Mesociclo de Pré-Otimização",
    summary: "Atingir o melhor controle pressórico e respiratório com intensidades próximas ao limite superior seguro (30% da Fmax).",
    weeklyFrequency: 3,
    stages: [
      { label: "Pré-ativação", durationSec: 60, restSec: 60, lowerPct: 0.24, upperPct: 0.28 },
      { label: "Sustentação máxima segura", durationSec: 60, restSec: 60, lowerPct: 0.27, upperPct: 0.30 },
      { label: "Descompressão", durationSec: 60, restSec: 60, lowerPct: 0.22, upperPct: 0.26 },
    ],
  },
  {
    id: "mesociclo-recuperativo",
    name: "Mesociclo Recuperativo",
    summary: "Favorecer a recuperação autonômica e a estabilidade hemodinâmica, mantendo estímulo leve e controlado.",
    weeklyFrequency: 2, // Frequência reduzida para recuperação
    stages: [
      { label: "Relaxamento ativo", durationSec: 60, restSec: 60, lowerPct: 0.15, upperPct: 0.18 },
      { label: "Controle suave", durationSec: 60, restSec: 60, lowerPct: 0.16, upperPct: 0.19 },
      { label: "Recuperação sustentada", durationSec: 60, restSec: 60, lowerPct: 0.15, upperPct: 0.18 },
    ],
  },
];

