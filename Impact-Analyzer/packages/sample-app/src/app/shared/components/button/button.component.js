var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Component, Input, Output, EventEmitter } from '@angular/core';
let SharedButtonComponent = class SharedButtonComponent {
    disabled = false;
    label = 'Click me';
    trigger = new EventEmitter();
};
__decorate([
    Input(),
    __metadata("design:type", Boolean)
], SharedButtonComponent.prototype, "disabled", void 0);
__decorate([
    Input(),
    __metadata("design:type", String)
], SharedButtonComponent.prototype, "label", void 0);
__decorate([
    Output(),
    __metadata("design:type", Object)
], SharedButtonComponent.prototype, "trigger", void 0);
SharedButtonComponent = __decorate([
    Component({
        selector: 'app-shared-button',
        templateUrl: './button.component.html',
        styleUrls: ['./button.component.scss']
    })
], SharedButtonComponent);
export { SharedButtonComponent };
//# sourceMappingURL=button.component.js.map