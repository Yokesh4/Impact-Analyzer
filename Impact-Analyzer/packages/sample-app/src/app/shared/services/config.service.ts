import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class ConfigService {
  private apiEndpoint = 'https://api.impactguard.com';

  getEndpoint() {
    return this.apiEndpoint;
  }
}
