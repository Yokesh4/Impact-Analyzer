import { SymbolType, RiskLevel } from '../types.js';

export class RiskEngine {
  public static calculateRisk(downstreamCount: number, type: SymbolType | 'route'): RiskLevel {
    if (type === 'module' || type === 'service') {
      if (downstreamCount > 5) return 'critical';
      if (downstreamCount > 0) return 'high';
      return 'medium';
    }

    if (type === 'css-selector') {
      if (downstreamCount > 15) return 'critical';
      if (downstreamCount > 5) return 'high';
      if (downstreamCount > 0) return 'medium';
      return 'low';
    }

    if (downstreamCount > 10) return 'critical';
    if (downstreamCount > 3) return 'high';
    if (downstreamCount > 0) return 'medium';
    return 'low';
  }
}
export default RiskEngine;
