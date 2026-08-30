import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Patch,
  Delete,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { CreateKnowledgeBaseDto } from './dto/create-knowledge-base.dto';
import { CreateKnowledgeDocumentDto } from './dto/create-knowledge-document.dto';
import { SearchKnowledgeDto } from './dto/search-knowledge.dto';
import { KnowledgeService } from './knowledge.service';

@Controller()
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Post('clients/:clientId/knowledge-bases')
  createBase(
    @Param('clientId') clientId: string,
    @Body() dto: CreateKnowledgeBaseDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.knowledgeService.createBase(clientId, dto, user.id);
  }

  @Get('clients/:clientId/knowledge-bases')
  listBases(
    @Param('clientId') clientId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.knowledgeService.listBases(clientId, user.id);
  }

  @Post('knowledge-bases/:baseId/documents')
  createDocument(
    @Param('baseId') baseId: string,
    @Body() dto: CreateKnowledgeDocumentDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.knowledgeService.createDocument(baseId, dto, user.id);
  }

  @Get('knowledge-bases/:baseId/documents')
  listDocuments(
    @Param('baseId') baseId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.knowledgeService.listDocuments(baseId, user.id);
  }

  @Get('knowledge-bases')
  listAllBases(@CurrentUser() user: { id: string }) {
    return this.knowledgeService.listAllBases(user.id);
  }

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('knowledge-bases/:baseId/search')
  search(
    @Param('baseId') baseId: string,
    @Body() dto: SearchKnowledgeDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.knowledgeService.search(baseId, dto, user.id);
  }

  @Patch('knowledge-bases/:id')
  updateBase(
    @Param('id') id: string,
    @Body() dto: Partial<CreateKnowledgeBaseDto>,
    @CurrentUser() user: { id: string },
  ) {
    return this.knowledgeService.updateBase(id, dto, user.id);
  }

  @Delete('knowledge-bases/:id')
  deleteBase(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.knowledgeService.deleteBase(id, user.id);
  }

  @Delete('knowledge-bases/:baseId/documents/:docId')
  deleteDocument(
    @Param('baseId') baseId: string,
    @Param('docId') docId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.knowledgeService.deleteDocument(baseId, docId, user.id);
  }
}
