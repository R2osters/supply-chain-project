import { Global, Module } from '@nestjs/common';
import { DomainEventsService } from './domain-events.service';

/**
 * Global because almost every write path publishes an event, and threading an import of this
 * module through fifteen feature modules would add noise without adding clarity.
 */
@Global()
@Module({
  providers: [DomainEventsService],
  exports: [DomainEventsService],
})
export class EventsModule {}
