/**
 * ─────────────────────────────────────────────────────────────────
 *  s3-locale-pt.js — Portuguese message catalogue
 * ─────────────────────────────────────────────────────────────────
 *  Translation by Lucas Kruger (@LKrugerr).
 *
 *  Keys are <plugin>.<surface>.<name>. English is the source of
 *  truth; every other catalogue mirrors its keys and placeholders.
 *
 *  Placeholders accept both {var} and {{var}}. New strings should
 *  use {var}.
 *
 *  Consumed by s3-i18n.js. See s3/LOCALIZATION.md for the rules on
 *  adding keys and contributing a language.
 * ─────────────────────────────────────────────────────────────────
 */

export const MESSAGES = {
  "s3DiscordPluginBase": {
    "errors": {
      "channelFetchFailed": "Não foi possível buscar o canal do Discord com channelID \"{channelID}\". Erro: {error}",
      "sendFailed": "Falha ao enviar mensagem do Discord: {error}",
      "sendFailedRetry": "Falha ao enviar mensagem do Discord após nova tentativa: {error}"
    },
    "defaults": {
      "embedFooter": "Serviços da Squad dos Slackers"
    }
  },
  "s3PluginBase": {
    "errors": {
      "pluginsNotAvailable": "[S3] server.plugins não está disponível. Não foi possível descobrir o SlackersSquadServices.",
      "servicesRequired": "[S3] SlackersSquadServices é obrigatório para este plugin. Certifique-se de que está no config.json antes deste plugin e reinicie.",
      "notDiscovered": "[S3] S³ não descoberto. Chame _resolveS3() ou certifique-se de que prepareToMount() foi executado.",
      "readyTimeout": "[S3] S³ não ficou pronto após o tempo limite de {timeoutMs}ms. Verifique se o SlackersSquadServices está montado e não está apresentando erros."
    },
    "teamChange": {
      "defaults": {
        "warnMessage": "Você foi embaralhado"
      }
    }
  },
  "slackersSquadServices": {
    "drift": {
      "embedTitle": "⚠️ Divergência de Schema Detectada",
      "footer": "Verificação de Schema do S³",
      "descriptionSummary": "Foi detectada uma divergência no schema ou nos dados — o estado esperado está ausente no banco de dados ativo.\nUse `!s3 migrate force` para reaplicar.\n\n{parts}",
      "descriptionFallback": "Divergência de schema detectada — use `!s3 migrate verify` para obter detalhes."
    },
    "driftViolations": {
      "emptyRows": "{offenders} linha(s) com `{column}` vazio"
    }
  },
  "switch": {
    "warn": {
      "matchendWarning": "[Switch] A rodada está terminando — você será trocado em 15 segundos.",
      "doubleSwitchTimeLimit": "Limite de tempo: troca dupla permitida apenas nos primeiros {{minutes}}min da entrada/partida.",
      "doubleSwitchCooldown": "Cooldown: troca dupla usada recentemente. Aguarde {{hours}}h.",
      "playerDoubleSwitched": "Jogador foi trocado duas vezes.",
      "doubleSwitchFailedSender": "Falha na troca dupla: {{message}}",
      "reconnectWrongTeam": "Você reconectou à equipe errada. Suas restrições de troca foram removidas — digite !switch para voltar à sua equipe anterior.",
      "noPlayerFoundMatching": "Nenhum jogador encontrado correspondente a: \"{{ident}}\"",
      "multiplePlayersMatching": "Vários jogadores correspondem a \"{{ident}}\". Use o SteamID.",
      "seedBonusEndgame": "Bônus de seed — você ganhou +1 token de troca por ajudar no seed (rodada encerrada). Agora você tem {{count}} token(s).",
      "seedBonusPeriodic": "Bônus de seed — você ganhou +1 token de troca por ajudar no seed. Agora você tem {{count}} token(s) ({{earned}}/{{cap}} tokens de bônus ganhos nesta rodada).",
      "scrambleMoveFailedTokenGranted": "[Switch] O scramble não conseguiu mover você — +1 token de troca concedido para você voltar ao seu grupo. Use !switch quando estiver pronto.",
      "scrambleMoveFailed": "[Switch] O scramble não conseguiu mover você — use !switch para voltar ao seu grupo."
    },
    "errors": {
      "incompatibleS3Version": "[Switch] Versão incompatível do S³: obtida {{actual}}, necessária >= {{required}}. Atualize o SlackersSquadServices.",
      "noEosIDResolved": "nenhum eosID pôde ser resolvido (steamID={{steamID}})",
      "teamChangeFailed": "Falha na mudança de equipe para {{eosID}} após {{attempts}} tentativa(s) (origem={{source}})"
    },
    "discord": {
      "scrambleEmbedTitle": "🌪️ Bloqueio de Scramble Iniciado",
      "scrambleEmbedDescription": "{{count}} jogadores foram impedidos de trocar de equipe pelos próximos {{minutes}} minutos.",
      "scrambleFieldDurationName": "Duração do Bloqueio",
      "scrambleFieldDurationValue": "{{minutes}} minutos",
      "scrambleFieldExpiresName": "Expira Em",
      "scrambleFieldPlayersName": "Jogadores Afetados"
    }
  },
  "teamBalancer": {
    "rcon": {
      "scrambleCancelledByAdmin": "Scramble cancelado pelo administrador."
    },
    "discord": {
      "commands": {
        "diagRunning": "🔄 Executando diagnósticos... aguarde.",
        "invalidCommand": "Comando inválido. Use: `status`, `diag`, `on`, `off`, `export`, `clear`, `help` ou `!scramble <now|dry|cancel>`."
      },
      "export": {
        "successContent": "📄 Aqui está a exportação dos relatórios de rodada do TeamBalancer:",
        "fileNotFound": "❌ O arquivo de log dos relatórios de rodada ainda não existe ou não pode ser acessado."
      },
      "clear": {
        "success": "✅ O arquivo de log dos relatórios de rodada foi limpo.",
        "failed": "❌ Falha ao limpar o arquivo de log dos relatórios de rodada: {error}"
      },
      "scramble": {
        "unknownArg": "❌ Argumento desconhecido \"{badArg}\". Uso: `!scramble [now|dry|matchend|cancel|confirm|elo]`",
        "noPendingConfirmation": "⚠️ Nenhuma confirmação de scramble pendente encontrada.",
        "confirmationExpired": "⚠️ A confirmação do scramble expirou.",
        "matchEndIncompatible": "❌ \"!scramble matchend\" não pode ser combinado com \"now\" ou \"dry\".",
        "matchEndAlreadyScheduled": "⚠️ Um scramble para o fim da partida já está agendado. Ele será executado quando esta rodada terminar. Use `!scramble cancel` para cancelá-lo.",
        "matchEndScheduled": "✅ Scramble agendado para o fim desta rodada. Ele será executado automaticamente quando a rodada terminar. Use `!scramble cancel` para cancelá-lo.",
        "matchEndScheduledMicro": "✅ Micro scramble agendado para o fim desta rodada. Ele será executado automaticamente quando a rodada terminar. Use `!scramble cancel` para cancelá-lo.",
        "cancelSuccess": "✅ Scramble pendente cancelado.",
        "cannotCancelExecuting": "⚠️ Não é possível cancelar o scramble — ele já está sendo executado.",
        "noPendingToCancel": "⚠️ Não há nenhum scramble pendente para cancelar.",
        "alreadyActive": "⚠️ O scramble já está {status}. Use `!scramble cancel` para cancelá-lo.",
        "timingImmediate": "imediatamente, sem contagem regressiva",
        "timingCountdown": "em {delay}s, após um aviso de contagem regressiva",
        "confirmPrompt": "⚠️ A confirmação executará um scramble {scrambleKind} {timing}. Digite `!scramble confirm` dentro de {timeoutSec}s para prosseguir.",
        "actionDryRun": "simulação {microLabel}scramble (imediato)",
        "actionImmediate": "{microLabel}scramble imediato",
        "actionCountdown": "{microLabel}scramble com contagem regressiva",
        "initiating": "🔄 Iniciando {actionDesc}...",
        "initiatingCountdownSuffix": "⏳ Contagem regressiva: {delay}s\n📢 Aviso enviado ao servidor.",
        "initiateFailed": "❌ Falha ao iniciar o scramble."
      },
      "toggle": {
        "alreadyEnabled": "✅ O rastreamento de sequência de vitórias já está ativado.",
        "alreadyDisabled": "✅ O rastreamento de sequência de vitórias já está desativado.",
        "disabledSuccess": "✅ Rastreamento de sequência de vitórias desativado."
      },
      "help": {
        "title": "📚 Referência de Comandos do TeamBalancer",
        "description": "Comandos disponíveis para administradores do Discord:",
        "fields": {
          "pluginCommands": {
            "name": "Comandos do Plugin",
            "value": "`!teambalancer status` - Mostra o estado atual e a sequência de vitórias\n`!teambalancer diag` - Executa diagnósticos e uma simulação\n`!teambalancer on` - Ativa o rastreamento de sequência de vitórias\n`!teambalancer off` - Desativa o rastreamento de sequência de vitórias\n`!teambalancer export` - Exporta o arquivo JSONL dos relatórios de rodada\n`!teambalancer clear` - Limpa o arquivo de log dos relatórios de rodada"
          },
          "scrambleCommands": {
            "name": "Comandos de Scramble",
            "value": "`!scramble` - Executa um scramble (com contagem regressiva)\n`!scramble now` - Executa um scramble imediatamente\n`!scramble dry` - Executa uma simulação (dry run)\n`!scramble matchend` - Agenda o scramble para o fim da rodada\n`!scramble cancel` - Cancela a contagem regressiva pendente"
          }
        }
      },
      "embeds": {
        "winStreakThresholdReached": "Limite de sequência de vitórias atingido"
      }
    },
    "errors": {
      "discordPermissionDenied": "❌ Você não tem permissão para usar este comando.",
      "s3VersionIncompatible": "[TeamBalancer] Versão do S³ incompatível: obteve {actual}, necessária >={required}. Por favor, atualize o SlackersSquadServices."
    },
    "broadcasts": {
      "warnAdminMatchEndDiscarded": "Seu scramble agendado para o fim da rodada foi descartado porque {reason}. Envie novamente \"!scramble matchend\" durante a rodada se ainda for necessário.",
      "discordMatchEndDiscarded": "⚠️ O scramble agendado para o fim da rodada (agendado por **{admin}**) foi descartado — {reason}.",
      "seedScrambleOffPendingScramble": " | Já existe uma contagem regressiva de scramble em andamento — use !scramble cancel para interrompê-la",
      "seedScrambleOffDisabled": " | O auto-scramble da Seed também está desativado enquanto o plugin estiver desativado",
      "enableConfirmationStreakOn": "Rastreamento de sequência de vitórias ativado.",
      "enableConfirmationStreakOff": "Plugin ativado — o rastreamento de sequência de vitórias permanece desativado na configuração.",
      "enableConfirmationSeedRearmed": " | Auto-scramble da Seed rearmado",
      "seedStatusConfigOff": "DESATIVADO (configuração)",
      "seedStatusPluginDisabled": "DESATIVADO (plugin desativado)",
      "seedStatusActive": "ATIVADO (no fim da rodada Seed)",
      "armDiscardedRestartReason": "uma reinicialização do servidor fez com que ele ultrapassasse a rodada para a qual foi agendado",
      "armDiscardedNewGameReason": "uma nova rodada começou antes que o scramble agendado pudesse ser executado"
    },
    "labels": {
      "adminSteamID": "admin {steamID}",
      "system": "sistema",
      "scrambleExecution": "Execução do Scramble",
      "cancelReasonAutomatic": "automaticamente",
      "cancelReasonAdmin": "pelo administrador {adminName}"
    },
    "embeds": {
      "noValidSwapSolutionFound": "Nenhuma solução válida de troca foi encontrada.",
      "discordServerBroadcastDescription": "📢 **Aviso do Servidor**\n{message}"
    }
  },
  "eloTracker": {
    "embeds": {
      "postScrambleTitle": "🔀 Balanceamento de Time Pós-Mistura - {layerName}",
      "roundSkipped": {
        "pluginNotReady": "Plugin não estava pronto ao final da rodada",
        "playerCountBelow": "Contagem de jogadores abaixo do limite (Modo de jogo: {gameMode})",
        "ignoredMatchType": "Tipo de partida ignorado: {reason}",
        "gameModeUnknown": "Modo de jogo desconhecido — pulando (padrão de segurança)",
        "noEligible": "Nenhum participante elegível (0 jogadores atingiram a minParticipationRatio de {ratio})",
        "oneOrBothIneligible": "Um ou ambos os times não tiveram participantes elegíveis (Modo de jogo: {gameMode})"
      }
    },
    "errors": {
      "incompatibleS3Version": "[EloTracker] Versão do S³ incompatível: obteve {actual}, necessária >={required}. Por favor, atualize o SlackersSquadServices."
    }
  }
};

/**
 * Key paths whose translation was machine-written and has NOT been reviewed
 * by a fluent speaker. Add a key here in the same commit that adds an
 * unreviewed string; delete it once someone who reads the language has
 * checked it. An empty array means this catalogue is fully reviewed.
 */
export const UNVERIFIED = [
  'teamBalancer.errors.discordPermissionDenied',
  'teamBalancer.errors.s3VersionIncompatible'
];
