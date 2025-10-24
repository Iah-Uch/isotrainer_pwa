// Module: Mesocycles library - Shared training plan definitions
// This is the single source of truth for all mesocycle definitions

export const FIXED_PLAN_LIBRARY = [
  {
    id: "mesociclo-incorporacao",
    name: "Mesociclo de Incorporação",
    summary: "Introduzir o usuário ao treino isométrico de preensão, priorizando tolerância e controle respiratório durante esforços leves e curtos.",
    weeklyFrequency: 3, // Frequência sugerida: 3 sessões por semana
    stages: [
      { label: "Familiarização", durationSec: 40, restSec: 60, lowerPct: 0.11, upperPct: 0.13 },
      { label: "Controle leve", durationSec: 40, restSec: 60, lowerPct: 0.12, upperPct: 0.14 },
      { label: "Consistência inicial", durationSec: 40, restSec: 60, lowerPct: 0.13, upperPct: 0.15 },
    ],
  },
  {
    id: "mesociclo-basico",
    name: "Mesociclo Básico",
    summary: "Aprimorar a capacidade de sustentar isometria com estabilidade de força e respiração, desenvolvendo adaptação autonômica inicial.",
    weeklyFrequency: 3,
    stages: [
      { label: "Estabilidade leve", durationSec: 40, restSec: 60, lowerPct: 0.14, upperPct: 0.16 },
      { label: "Controle respiratório", durationSec: 40, restSec: 60, lowerPct: 0.15, upperPct: 0.18 },
      { label: "Sustentação moderada", durationSec: 40, restSec: 60, lowerPct: 0.17, upperPct: 0.19 },
    ],
  },
  {
    id: "mesociclo-estabilizador",
    name: "Mesociclo Estabilizador",
    summary: "Consolidar o controle pressórico e respiratório, reduzindo a variabilidade da força e aprimorando o equilíbrio autonômico.",
    weeklyFrequency: 3,
    stages: [
      { label: "Controle sustentado", durationSec: 40, restSec: 60, lowerPct: 0.16, upperPct: 0.19 },
      { label: "Estabilidade contínua", durationSec: 40, restSec: 60, lowerPct: 0.18, upperPct: 0.20 },
      { label: "Refinamento técnico", durationSec: 40, restSec: 60, lowerPct: 0.18, upperPct: 0.21 },
    ],
  },
  {
    id: "mesociclo-controle",
    name: "Mesociclo de Controle",
    summary: "Avaliar o progresso do controle pressórico e autonômico, ajustando a faixa de intensidade conforme a resposta do usuário.",
    weeklyFrequency: 3,
    stages: [
      { label: "Aquecimento leve", durationSec: 40, restSec: 60, lowerPct: 0.14, upperPct: 0.17 },
      { label: "Avaliação controlada", durationSec: 40, restSec: 60, lowerPct: 0.17, upperPct: 0.20 },
      { label: "Estabilidade máxima", durationSec: 40, restSec: 60, lowerPct: 0.19, upperPct: 0.21 },
    ],
  },
  {
    id: "mesociclo-pre-otimizacao",
    name: "Mesociclo de Pré-Otimização",
    summary: "Atingir o melhor controle pressórico e respiratório com intensidades próximas ao limite superior seguro (30% da Fmax).",
    weeklyFrequency: 3,
    stages: [
      { label: "Pré-ativação", durationSec: 40, restSec: 60, lowerPct: 0.17, upperPct: 0.20 },
      { label: "Sustentação máxima segura", durationSec: 40, restSec: 60, lowerPct: 0.19, upperPct: 0.21 },
      { label: "Descompressão", durationSec: 40, restSec: 60, lowerPct: 0.15, upperPct: 0.18 },
    ],
  },
  {
    id: "mesociclo-recuperativo",
    name: "Mesociclo Recuperativo",
    summary: "Favorecer a recuperação autonômica e a estabilidade hemodinâmica, mantendo estímulo leve e controlado.",
    weeklyFrequency: 2, // Frequência reduzida para recuperação
    stages: [
      { label: "Relaxamento ativo", durationSec: 40, restSec: 60, lowerPct: 0.11, upperPct: 0.13 },
      { label: "Controle suave", durationSec: 40, restSec: 60, lowerPct: 0.11, upperPct: 0.13 },
      { label: "Recuperação sustentada", durationSec: 40, restSec: 60, lowerPct: 0.11, upperPct: 0.13 },
    ],
  },
];

