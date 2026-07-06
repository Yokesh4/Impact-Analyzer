import { OnInit } from '@angular/core';
import { ConfigService } from '../../shared/services/config.service';
export declare class DashboardComponent implements OnInit {
    private configService;
    endpoint: string;
    constructor(configService: ConfigService);
    ngOnInit(): void;
    onSave(): void;
}
