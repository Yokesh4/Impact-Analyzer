import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { AppRoutingModule } from './app-routing.module';
import { DashboardComponent } from './features/dashboard/dashboard.component';
import { SharedButtonComponent } from './shared/components/button/button.component';
import { ConfigService } from './shared/services/config.service';

@NgModule({
  declarations: [
    DashboardComponent,
    SharedButtonComponent
  ],
  imports: [
    BrowserModule,
    AppRoutingModule
  ],
  providers: [ConfigService]
})
export class AppModule { }
