import { Component, Input, Output, EventEmitter } from '@angular/core';

@Component({
  selector: 'app-shared-button',
  templateUrl: './button.component.html',
  styleUrls: ['./button.component.scss']
})
export class SharedButtonComponent {
  @Input() disabled: boolean = false;
  @Input() label: string = 'Click me';
  @Output() trigger = new EventEmitter<void>();
}
