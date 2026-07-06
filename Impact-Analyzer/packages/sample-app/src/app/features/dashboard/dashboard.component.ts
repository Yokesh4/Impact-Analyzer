import { Component, OnInit } from '@angular/core';
import { ConfigService } from '../../shared/services/config.service';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export class DashboardComponent implements OnInit {
  endpoint: string = '';

  constructor(private configService: ConfigService) { }

  ngOnInit() {
    this.endpoint = this.configService.getEndpoint();
  }

  onSave() {
    console.log('Save clicked on dashboard!');
  }
}
