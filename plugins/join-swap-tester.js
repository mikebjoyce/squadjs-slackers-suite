/**
 * JOIN-SWAP-TESTER MINIMALIST CONFIG:
 * 
 * {
 *   "plugin": "JoinSwapTester",
 *   "enabled": true
 * }
 */

import Logger from '../../core/logger.js';
import BasePlugin from './base-plugin.js';
import SASwapExecutor from '../utils/sa-swap-executor.js';

export default class JoinSwapTester extends BasePlugin {
  static version = '1.1.0';

  static get description() {
    return 'Full-Lifecycle Telemetry - Profile Join and Log-Based Disconnect detection.';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      targetEOSID: {
        required: false,
        description: 'EOSID of the player to monitor.',
        default: '0002fc6f599e418ba9c56172698b0396', // Slacker
        type: 'string'
      },
      targetName: {
        required: false,
        description: 'Name of the player to monitor (fallback).',
        default: 'Slacker',
        type: 'string'
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.executor = new SASwapExecutor(server, {
      retryIntervalMs: 500,
      maxCompletionTimeMs: 15000 
    });

    this.states = {
      IDLE: 'IDLE',
      QUEUED: 'QUEUED',
      VERIFIED: 'VERIFIED'
    };

    this.currentState = this.states.IDLE;
    this.targetData = {
      steamID: null,
      name: null,
      startingTeam: null,
      targetTeam: null
    };

    this.telemetry = {
      startTime: 0,        
      assignmentTime: 0,   
      completionTime: 0,
      realLeaveTime: 0,    
      rconLeaveTime: 0     
    };

    this.onPlayerConnected = this.onPlayerConnected.bind(this);
    this.onUpdatedPlayerInfo = this.onUpdatedPlayerInfo.bind(this);
    this.onMoveSuccess = this.onMoveSuccess.bind(this);
    this.onMoveFailed = this.onMoveFailed.bind(this);
  }

  async mount() {
    this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.on('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInfo);
    this.server.on('SMART_ASSIGN_MOVE_SUCCESS', this.onMoveSuccess);
    this.server.on('SMART_ASSIGN_MOVE_FAILED', this.onMoveFailed);
    
    // CUSTOM LOG-PARSER HOOK: Instant Disconnect Detection
    // This regex looks for the exact millisecond the connection closes.
    if (this.server.logParser) {
       this.server.logParser.on('line', (line) => {
          if (line.includes('UNetConnection::Close') || line.includes('UChannel::Close')) {
             // If the line contains the target's identifiers
             if (line.includes(this.options.targetEOSID) || (this.targetData.steamID && line.includes(this.targetData.steamID))) {
                if (this.telemetry.realLeaveTime === 0) {
                   this.telemetry.realLeaveTime = Date.now();
                   Logger.verbose('JoinSwapTester', 1, `[TELEMETRY] LOG-LEAVE: Engine connection closure detected for ${this.targetData.name}.`);
                }
             }
          }
       });
    }

    Logger.verbose('JoinSwapTester', 1, `[LIFECYCLE-MONITOR-V1.1] mounted targeting: ${this.options.targetEOSID}`);
  }

  async unmount() {
    this.server.removeListener('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInfo);
    this.server.removeListener('SMART_ASSIGN_MOVE_SUCCESS', this.onMoveSuccess);
    this.server.removeListener('SMART_ASSIGN_MOVE_FAILED', this.onMoveFailed);
    this.executor.cleanup();
  }

  async onPlayerConnected(info) {
    const player = info.player;
    if (!player || (player.eosID !== this.options.targetEOSID && !player.name.includes(this.options.targetName))) return;

    this.currentState = this.states.QUEUED;
    
    const listPlayer = this.server.players.find(p => p.eosID === this.options.targetEOSID || p.name.includes(this.options.targetName));
    
    // STRICT TOGGLE: Always swap to the other team.
    // If they aren't in the list yet, assume they are Team 1 and swap to 2.
    const startingTeam = listPlayer ? Number(listPlayer.teamID) : 1;
    const targetTeam = startingTeam === 1 ? 2 : 1;

     this.targetData = {
        steamID: info.steamID || (listPlayer ? listPlayer.steamID : null),
        name: player.name,
        startingTeam: startingTeam,
        targetTeam: targetTeam
     };

     if (!this.targetData.steamID) {
       Logger.verbose('JoinSwapTester', 1, `[TELEMETRY] WARNING: steamID is null for ${player.name}. queueMove will be a no-op. Check log parser timing.`);
     }

     this.telemetry = {
       startTime: Date.now(),
       assignmentTime: Date.now(),
       completionTime: 0,
       realLeaveTime: 0,
       rconLeaveTime: 0
     };

     Logger.verbose('JoinSwapTester', 1, `[TELEMETRY] JOIN: ${player.name} connected. Starting Toggle Swap (${startingTeam} -> ${targetTeam})...`);
     this.executor.queueMove(this.targetData.steamID, targetTeam);
  }

  async onUpdatedPlayerInfo() {
    // DISCONNECT PROFILING
    const player = this.server.players.find(p => 
      p.eosID === this.options.targetEOSID || 
      (p.name && p.name.includes(this.options.targetName))
    );

    // If player is GONE from RCON list and we are in VERIFIED state
    if (!player && this.currentState === this.states.VERIFIED) {
       this.telemetry.rconLeaveTime = Date.now();
       
       // Calculate delay from Log-Closure to RCON-Disappearance
       const delay = this.telemetry.rconLeaveTime - (this.telemetry.realLeaveTime || this.telemetry.rconLeaveTime);
       
       Logger.verbose('JoinSwapTester', 1, `
╔═══════════════════════════════════════════════════════════════╗
║                 DISCONNECT TELEMETRY REPORT                   ║
╠═══════════════════════════════════════════════════════════════╣
  Player: ${this.targetData.name}
  
  RCON Detection Delay:          ${delay}ms
  Log-Based Leave Captured:      ${this.telemetry.realLeaveTime > 0 ? 'YES' : 'NO'}
  
  Status: Target has left the RCON player list. Resetting machine.
╚═══════════════════════════════════════════════════════════════╝`);
       this.currentState = this.states.IDLE;
    }
  }

  async onMoveSuccess(data) {
    if (!this._isTarget(data)) return;

    this.currentState = this.states.VERIFIED;
    this.telemetry.completionTime = Date.now();

    Logger.verbose('JoinSwapTester', 1, `
╔═══════════════════════════════════════════════════════════════╗
║                  TOGGLE-SWAP TELEMETRY REPORT                 ║
╠═══════════════════════════════════════════════════════════════╣
  Player: ${data.name || 'Target'}
  
  Starting Team (Detected):      ${this.targetData.startingTeam}
  VERIFIED Team (New):           ${data.teamID}
  
  >> TOTAL JOIN-TO-SWAP:         ${this.telemetry.completionTime - this.telemetry.startTime}ms <<
  
  Status: Physical swap verified. Monitoring for disconnect...
╚═══════════════════════════════════════════════════════════════╝`);
  }

  async onMoveFailed(data) {
    if (!this._isTarget(data)) return;
    Logger.verbose('JoinSwapTester', 1, `[TELEMETRY] [FAIL] Reason: ${data.reason}`);
    this.currentState = this.states.IDLE;
  }

   _isTarget(data) {
      // Guard against null === null false match (prevents random move events from matching when steamID is missing)
      if (!this.targetData.steamID && !data.steamID) return false;
      return data.steamID === this.targetData.steamID || data.eosID === this.options.targetEOSID;
   }
}
