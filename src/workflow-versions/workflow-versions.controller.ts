import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { WorkflowVersionsService } from './workflow-versions.service';
import {
  PublishVersionDto,
  RollbackVersionDto,
  CreateSnapshotDto,
  UpdateVersionDto,
} from './dto/workflow-version.dto';
import { CurrentUser } from '../common/auth/current-user.decorator';

@Controller('clients/:clientId/workflow-versions')
export class WorkflowVersionsController {
  constructor(
    private readonly workflowVersionsService: WorkflowVersionsService,
  ) {}

  @Get()
  list(
    @Param('clientId') clientId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.workflowVersionsService.list(clientId, user.id);
  }

  @Get('editing')
  getEditing(
    @Param('clientId') clientId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.workflowVersionsService.getEditingVersion(clientId, user.id);
  }

  @Post('save-editing')
  saveEditing(
    @Param('clientId') clientId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.workflowVersionsService.saveCurrentEditing(clientId, user.id);
  }

  @Get('draft')
  getDraft(
    @Param('clientId') clientId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.workflowVersionsService.getDraft(clientId, user.id);
  }

  @Get('published')
  getPublished(
    @Param('clientId') clientId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.workflowVersionsService.getPublished(clientId, user.id);
  }

  @Get('diff')
  diff(
    @Param('clientId') clientId: string,
    @Query('v1') v1: string,
    @Query('v2') v2: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.workflowVersionsService.diff(
      clientId,
      v1 || 'published',
      v2 || 'current',
      user.id,
    );
  }

  @Get(':versionId')
  getById(
    @Param('clientId') clientId: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.workflowVersionsService.getById(clientId, versionId, user.id);
  }

  @Post('snapshot')
  createDraftSnapshot(
    @Param('clientId') clientId: string,
    @Body() dto: CreateSnapshotDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.workflowVersionsService.createDraftSnapshot(
      clientId,
      dto,
      user.id,
    );
  }

  @Post(':versionId/publish')
  publish(
    @Param('clientId') clientId: string,
    @Param('versionId') versionId: string,
    @Body() dto: PublishVersionDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.workflowVersionsService.publish(
      clientId,
      versionId,
      dto,
      user.id,
    );
  }

  @Post(':versionId/activate')
  activate(
    @Param('clientId') clientId: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.workflowVersionsService.activate(clientId, versionId, user.id);
  }

  @Post(':versionId/checkout')
  checkout(
    @Param('clientId') clientId: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.workflowVersionsService.checkout(clientId, versionId, user.id);
  }

  @Post(':versionId/rollback')
  rollback(
    @Param('clientId') clientId: string,
    @Param('versionId') versionId: string,
    @Body() dto: RollbackVersionDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.workflowVersionsService.rollback(
      clientId,
      versionId,
      dto,
      user.id,
    );
  }

  @Patch(':versionId')
  update(
    @Param('clientId') clientId: string,
    @Param('versionId') versionId: string,
    @Body() dto: UpdateVersionDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.workflowVersionsService.update(
      clientId,
      versionId,
      dto,
      user.id,
    );
  }

  @Delete(':versionId')
  remove(
    @Param('clientId') clientId: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.workflowVersionsService.delete(clientId, versionId, user.id);
  }
}
